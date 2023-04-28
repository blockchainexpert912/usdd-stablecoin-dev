const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");

const { keccak256 } = require("@ethersproject/keccak256");
const { defaultAbiCoder } = require("@ethersproject/abi");
const { toUtf8Bytes } = require("@ethersproject/strings");
const { pack } = require("@ethersproject/solidity");
const { hexlify } = require("@ethersproject/bytes");
const { ecsign } = require("ethereumjs-util");

const { toBN, assertRevert, assertAssert, dec, ZERO_ADDRESS } = testHelpers.TestHelper;

const sign = (digest, privateKey) => {
  return ecsign(Buffer.from(digest.slice(2), "hex"), Buffer.from(privateKey.slice(2), "hex"));
};

const PERMIT_TYPEHASH = keccak256(
  toUtf8Bytes("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
);

// Gets the EIP712 domain separator
const getDomainSeparator = (name, contractAddress, chainId, version) => {
  return keccak256(
    defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        keccak256(
          toUtf8Bytes(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
          )
        ),
        keccak256(toUtf8Bytes(name)),
        keccak256(toUtf8Bytes(version)),
        parseInt(chainId),
        contractAddress.toLowerCase()
      ]
    )
  );
};

// Returns the EIP712 hash which should be signed by the user
// in order to make a call to `permit`
const getPermitDigest = (
  name,
  address,
  chainId,
  version,
  owner,
  spender,
  value,
  nonce,
  deadline
) => {
  const DOMAIN_SEPARATOR = getDomainSeparator(name, address, chainId, version);
  return keccak256(
    pack(
      ["bytes1", "bytes1", "bytes32", "bytes32"],
      [
        "0x19",
        "0x01",
        DOMAIN_SEPARATOR,
        keccak256(
          defaultAbiCoder.encode(
            ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
            [PERMIT_TYPEHASH, owner, spender, value, nonce, deadline]
          )
        )
      ]
    )
  );
};

contract("USDDToken", async accounts => {
  const [owner, alice, bob, carol, dennis] = accounts;

  // the second account our hardhatenv creates (for Alice)
  // from https://github.com/liquity/dev/blob/main/packages/contracts/hardhatAccountsList2k.js#L3
  const alicePrivateKey = "0xeaa445c85f7b438dEd6e831d06a4eD0CEBDc2f8527f84Fcda6EBB5fCfAd4C0e9";

  let chainId;
  let usddTokenOriginal;
  let usddTokenTester;
  let stabilityPool;
  let troveManager;
  let borrowerOperations;

  let tokenName;
  let tokenVersion;

  const testCorpus = ({ withProxy = false }) => {
    beforeEach(async () => {
      const contracts = await deploymentHelper.deployTesterContractsHardhat();

      const DEFTContracts = await deploymentHelper.deployDEFTContracts();

      await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

      usddTokenOriginal = contracts.usddToken;
      if (withProxy) {
        const users = [alice, bob, carol, dennis];
        await deploymentHelper.deployProxyScripts(contracts, DEFTContracts, owner, users);
      }

      usddTokenTester = contracts.usddToken;
      // for some reason this doesn’t work with coverage network
      //chainId = await web3.eth.getChainId()
      chainId = await usddTokenOriginal.getChainId();

      stabilityPool = contracts.stabilityPool;
      troveManager = contracts.stabilityPool;
      borrowerOperations = contracts.borrowerOperations;

      tokenVersion = await usddTokenOriginal.version();
      tokenName = await usddTokenOriginal.name();

      // mint some tokens
      if (withProxy) {
        await usddTokenOriginal.unprotectedMint(usddTokenTester.getProxyAddressFromUser(alice), 150);
        await usddTokenOriginal.unprotectedMint(usddTokenTester.getProxyAddressFromUser(bob), 100);
        await usddTokenOriginal.unprotectedMint(usddTokenTester.getProxyAddressFromUser(carol), 50);
      } else {
        await usddTokenOriginal.unprotectedMint(alice, 150);
        await usddTokenOriginal.unprotectedMint(bob, 100);
        await usddTokenOriginal.unprotectedMint(carol, 50);
      }
    });

    it("balanceOf(): gets the balance of the account", async () => {
      const aliceBalance = (await usddTokenTester.balanceOf(alice)).toNumber();
      const bobBalance = (await usddTokenTester.balanceOf(bob)).toNumber();
      const carolBalance = (await usddTokenTester.balanceOf(carol)).toNumber();

      assert.equal(aliceBalance, 150);
      assert.equal(bobBalance, 100);
      assert.equal(carolBalance, 50);
    });

    it("totalSupply(): gets the total supply", async () => {
      const total = (await usddTokenTester.totalSupply()).toString();
      assert.equal(total, "300"); // 300
    });

    it("name(): returns the token's name", async () => {
      const name = await usddTokenTester.name();
      assert.equal(name, "USDD Stablecoin");
    });

    it("symbol(): returns the token's symbol", async () => {
      const symbol = await usddTokenTester.symbol();
      assert.equal(symbol, "USDD");
    });

    it("decimal(): returns the number of decimal digits used", async () => {
      const decimals = await usddTokenTester.decimals();
      assert.equal(decimals, "18");
    });

    it("allowance(): returns an account's spending allowance for another account's balance", async () => {
      await usddTokenTester.approve(alice, 100, { from: bob });

      const allowance_A = await usddTokenTester.allowance(bob, alice);
      const allowance_D = await usddTokenTester.allowance(bob, dennis);

      assert.equal(allowance_A, 100);
      assert.equal(allowance_D, "0");
    });

    it("approve(): approves an account to spend the specified amount", async () => {
      const allowance_A_before = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_before, "0");

      await usddTokenTester.approve(alice, 100, { from: bob });

      const allowance_A_after = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_after, 100);
    });

    if (!withProxy) {
      it("approve(): reverts when spender param is address(0)", async () => {
        const txPromise = usddTokenTester.approve(ZERO_ADDRESS, 100, { from: bob });
        await assertAssert(txPromise);
      });

      it("approve(): reverts when owner param is address(0)", async () => {
        const txPromise = usddTokenTester.callInternalApprove(ZERO_ADDRESS, alice, dec(1000, 18), {
          from: bob
        });
        await assertAssert(txPromise);
      });
    }

    it("transferFrom(): successfully transfers from an account which is it approved to transfer from", async () => {
      const allowance_A_0 = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_0, "0");

      await usddTokenTester.approve(alice, 50, { from: bob });

      // Check A's allowance of Bob's funds has increased
      const allowance_A_1 = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_1, 50);

      assert.equal(await usddTokenTester.balanceOf(carol), 50);

      // Alice transfers from bob to Carol, using up her allowance
      await usddTokenTester.transferFrom(bob, carol, 50, { from: alice });
      assert.equal(await usddTokenTester.balanceOf(carol), 100);

      // Check A's allowance of Bob's funds has decreased
      const allowance_A_2 = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_2, "0");

      // Check bob's balance has decreased
      assert.equal(await usddTokenTester.balanceOf(bob), 50);

      // Alice tries to transfer more tokens from bob's account to carol than she's allowed
      const txPromise = usddTokenTester.transferFrom(bob, carol, 50, { from: alice });
      await assertRevert(txPromise);
    });

    it("transfer(): increases the recipient's balance by the correct amount", async () => {
      assert.equal(await usddTokenTester.balanceOf(alice), 150);

      await usddTokenTester.transfer(alice, 37, { from: bob });

      assert.equal(await usddTokenTester.balanceOf(alice), 187);
    });

    it("transfer(): reverts if amount exceeds sender's balance", async () => {
      assert.equal(await usddTokenTester.balanceOf(bob), 100);

      const txPromise = usddTokenTester.transfer(alice, 101, { from: bob });
      await assertRevert(txPromise);
    });

    it("transfer(): transferring to a blacklisted address reverts", async () => {
      await assertRevert(usddTokenTester.transfer(usddTokenTester.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(ZERO_ADDRESS, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(troveManager.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(stabilityPool.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(borrowerOperations.address, 1, { from: alice }));
    });

    it("increaseAllowance(): increases an account's allowance by the correct amount", async () => {
      const allowance_A_Before = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_Before, "0");

      await usddTokenTester.increaseAllowance(alice, 100, { from: bob });

      const allowance_A_After = await usddTokenTester.allowance(bob, alice);
      assert.equal(allowance_A_After, 100);
    });

    if (!withProxy) {
      it("mint(): issues correct amount of tokens to the given address", async () => {
        const alice_balanceBefore = await usddTokenTester.balanceOf(alice);
        assert.equal(alice_balanceBefore, 150);

        await usddTokenTester.unprotectedMint(alice, 100);

        const alice_BalanceAfter = await usddTokenTester.balanceOf(alice);
        assert.equal(alice_BalanceAfter, 250);
      });

      it("burn(): burns correct amount of tokens from the given address", async () => {
        const alice_balanceBefore = await usddTokenTester.balanceOf(alice);
        assert.equal(alice_balanceBefore, 150);

        await usddTokenTester.unprotectedBurn(alice, 70);

        const alice_BalanceAfter = await usddTokenTester.balanceOf(alice);
        assert.equal(alice_BalanceAfter, 80);
      });

      // TODO: Rewrite this test - it should check the actual usddTokenTester's balance.
      it("sendToPool(): changes balances of Stability pool and user by the correct amounts", async () => {
        const stabilityPool_BalanceBefore = await usddTokenTester.balanceOf(stabilityPool.address);
        const bob_BalanceBefore = await usddTokenTester.balanceOf(bob);
        assert.equal(stabilityPool_BalanceBefore, 0);
        assert.equal(bob_BalanceBefore, 100);

        await usddTokenTester.unprotectedSendToPool(bob, stabilityPool.address, 75);

        const stabilityPool_BalanceAfter = await usddTokenTester.balanceOf(stabilityPool.address);
        const bob_BalanceAfter = await usddTokenTester.balanceOf(bob);
        assert.equal(stabilityPool_BalanceAfter, 75);
        assert.equal(bob_BalanceAfter, 25);
      });

      it("returnFromPool(): changes balances of Stability pool and user by the correct amounts", async () => {
        /// --- SETUP --- give pool 100 USDD
        await usddTokenTester.unprotectedMint(stabilityPool.address, 100);

        /// --- TEST ---
        const stabilityPool_BalanceBefore = await usddTokenTester.balanceOf(stabilityPool.address);
        const bob_BalanceBefore = await usddTokenTester.balanceOf(bob);
        assert.equal(stabilityPool_BalanceBefore, 100);
        assert.equal(bob_BalanceBefore, 100);

        await usddTokenTester.unprotectedReturnFromPool(stabilityPool.address, bob, 75);

        const stabilityPool_BalanceAfter = await usddTokenTester.balanceOf(stabilityPool.address);
        const bob_BalanceAfter = await usddTokenTester.balanceOf(bob);
        assert.equal(stabilityPool_BalanceAfter, 25);
        assert.equal(bob_BalanceAfter, 175);
      });
    }

    it("transfer(): transferring to a blacklisted address reverts", async () => {
      await assertRevert(usddTokenTester.transfer(usddTokenTester.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(ZERO_ADDRESS, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(troveManager.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(stabilityPool.address, 1, { from: alice }));
      await assertRevert(usddTokenTester.transfer(borrowerOperations.address, 1, { from: alice }));
    });

    it("decreaseAllowance(): decreases allowance by the expected amount", async () => {
      await usddTokenTester.approve(bob, dec(3, 18), { from: alice });
      assert.equal((await usddTokenTester.allowance(alice, bob)).toString(), dec(3, 18));
      await usddTokenTester.decreaseAllowance(bob, dec(1, 18), { from: alice });
      assert.equal((await usddTokenTester.allowance(alice, bob)).toString(), dec(2, 18));
    });

    it("decreaseAllowance(): fails trying to decrease more than previously allowed", async () => {
      await usddTokenTester.approve(bob, dec(3, 18), { from: alice });
      assert.equal((await usddTokenTester.allowance(alice, bob)).toString(), dec(3, 18));
      await assertRevert(
        usddTokenTester.decreaseAllowance(bob, dec(4, 18), { from: alice }),
        "ERC20: decreased allowance below zero"
      );
      assert.equal((await usddTokenTester.allowance(alice, bob)).toString(), dec(3, 18));
    });

    // EIP2612 tests

    if (!withProxy) {
      it("version(): returns the token contract's version", async () => {
        const version = await usddTokenTester.version();
        assert.equal(version, "1");
      });

      it("Initializes PERMIT_TYPEHASH correctly", async () => {
        assert.equal(await usddTokenTester.permitTypeHash(), PERMIT_TYPEHASH);
      });

      it("Initializes DOMAIN_SEPARATOR correctly", async () => {
        assert.equal(
          await usddTokenTester.domainSeparator(),
          getDomainSeparator(tokenName, usddTokenTester.address, chainId, tokenVersion)
        );
      });

      it("Initial nonce for a given address is 0", async function () {
        assert.equal(toBN(await usddTokenTester.nonces(alice)).toString(), "0");
      });

      // Create the approval tx data
      const approve = {
        owner: alice,
        spender: bob,
        value: 1
      };

      const buildPermitTx = async deadline => {
        const nonce = (await usddTokenTester.nonces(approve.owner)).toString();

        // Get the EIP712 digest
        const digest = getPermitDigest(
          tokenName,
          usddTokenTester.address,
          chainId,
          tokenVersion,
          approve.owner,
          approve.spender,
          approve.value,
          nonce,
          deadline
        );

        const { v, r, s } = sign(digest, alicePrivateKey);

        const tx = usddTokenTester.permit(
          approve.owner,
          approve.spender,
          approve.value,
          deadline,
          v,
          hexlify(r),
          hexlify(s)
        );

        return { v, r, s, tx };
      };

      it("permits and emits an Approval event (replay protected)", async () => {
        const deadline = 100000000000000;

        // Approve it
        const { v, r, s, tx } = await buildPermitTx(deadline);
        const receipt = await tx;
        const event = receipt.logs[0];

        // Check that approval was successful
        assert.equal(event.event, "Approval");
        assert.equal(await usddTokenTester.nonces(approve.owner), 1);
        assert.equal(await usddTokenTester.allowance(approve.owner, approve.spender), approve.value);

        // Check that we can not use re-use the same signature, since the user's nonce has been incremented (replay protection)
        await assertRevert(
          usddTokenTester.permit(approve.owner, approve.spender, approve.value, deadline, v, r, s),
          "USDD: invalid signature"
        );

        // Check that the zero address fails
        await assertAssert(
          usddTokenTester.permit(
            "0x0000000000000000000000000000000000000000",
            approve.spender,
            approve.value,
            deadline,
            "0x99",
            r,
            s
          )
        );
      });

      it("permits(): fails with expired deadline", async () => {
        const deadline = 1;

        const { v, r, s, tx } = await buildPermitTx(deadline);
        await assertRevert(tx, "USDD: expired deadline");
      });

      it("permits(): fails with the wrong signature", async () => {
        const deadline = 100000000000000;

        const { v, r, s } = await buildPermitTx(deadline);

        const tx = usddTokenTester.permit(
          carol,
          approve.spender,
          approve.value,
          deadline,
          v,
          hexlify(r),
          hexlify(s)
        );

        await assertRevert(tx, "USDD: invalid signature");
      });
    }
  };
  describe("Basic token functions, without Proxy", async () => {
    testCorpus({ withProxy: false });
  });

  describe("Basic token functions, with Proxy", async () => {
    testCorpus({ withProxy: true });
  });
});

contract("Reset chain state", async accounts => {});
