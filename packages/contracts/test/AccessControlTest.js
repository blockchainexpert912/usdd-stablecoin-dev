const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");
const TroveManagerTester = artifacts.require("TroveManagerTester");

const th = testHelpers.TestHelper;
const timeValues = testHelpers.TimeValues;

const dec = th.dec;
const toBN = th.toBN;
const assertRevert = th.assertRevert;

/* The majority of access control tests are contained in this file. However, tests for restrictions 
on the Liquity admin address's capabilities during the first year are found in:

test/launchSequenceTest/DuringLockupPeriodTest.js */

contract(
  "Access Control: Liquity functions with the caller restricted to Liquity contract(s)",
  async accounts => {
    const [owner, alice, bob, carol] = accounts;

    let coreContracts;

    let priceFeed;
    let usddToken;
    let sortedTroves;
    let troveManager;
    let nameRegistry;
    let activePool;
    let stabilityPool;
    let defaultPool;
    let functionCaller;
    let borrowerOperations;
    let collToken;

    let deftStaking;
    let deftToken;
    let communityIssuance;

    before(async () => {
      coreContracts = await deploymentHelper.deployLiquityCore();
      coreContracts.troveManager = await TroveManagerTester.new();
      coreContracts = await deploymentHelper.deployUSDDTokenTester(coreContracts);
      const DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();

      priceFeed = coreContracts.priceFeed;
      usddToken = coreContracts.usddToken;
      sortedTroves = coreContracts.sortedTroves;
      troveManager = coreContracts.troveManager;
      nameRegistry = coreContracts.nameRegistry;
      activePool = coreContracts.activePool;
      stabilityPool = coreContracts.stabilityPool;
      defaultPool = coreContracts.defaultPool;
      functionCaller = coreContracts.functionCaller;
      borrowerOperations = coreContracts.borrowerOperations;
      collToken = coreContracts.weth;

      deftStaking = DEFTContracts.deftStaking;
      deftToken = DEFTContracts.deftToken;
      communityIssuance = DEFTContracts.communityIssuance;

      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectCoreContracts(coreContracts, DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, coreContracts);

      for (account of accounts.slice(0, 10)) {
        await th.openTrove(coreContracts, {
          extraUSDDAmount: toBN(dec(20000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: account }
        });
      }
    });

    describe("BorrowerOperations", async accounts => {
      it("moveCollGainToTrove(): reverts when called by an account that is not StabilityPool", async () => {
        // Attempt call from alice
        try {
          const tx1 = await borrowerOperations.moveCollGainToTrove(
            bob,
            collToken.address,
            bob,
            bob,
            { from: bob }
          );
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "BorrowerOps: Caller is not Stability Pool")
        }
      });
    });

    describe("TroveManager", async accounts => {
      // applyPendingRewards
      it("applyPendingRewards(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.applyPendingRewards(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // updateRewardSnapshots
      it("updateRewardSnapshots(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.updateTroveRewardSnapshots(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // removeStake
      it("removeStake(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.removeStake(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // updateStakeAndTotalStakes
      it("updateStakeAndTotalStakes(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.updateStakeAndTotalStakes(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // closeTrove
      it("closeTrove(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.closeTrove(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // addTroveOwnerToArray
      it("addTroveOwnerToArray(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.addTroveOwnerToArray(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // setTroveStatus
      it("setTroveStatus(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.setTroveStatus(bob, 1, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // increaseTroveColl
      it("increaseTroveColl(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.increaseTroveColl(bob, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // decreaseTroveColl
      it("decreaseTroveColl(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.decreaseTroveColl(bob, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // increaseTroveDebt
      it("increaseTroveDebt(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.increaseTroveDebt(bob, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });

      // decreaseTroveDebt
      it("decreaseTroveDebt(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        try {
          const txAlice = await troveManager.decreaseTroveDebt(bob, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is not the BorrowerOperations contract")
        }
      });
    });

    describe("ActivePool", async accounts => {
      // sendETH
      it("sendETH(): reverts when called by an account that is not BO nor TroveM nor SP", async () => {
        // Attempt call from alice
        try {
          const txAlice = await activePool.sendColl(alice, collToken.address, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(
            err.message,
            "Caller is neither BorrowerOperations nor TroveManager nor StabilityPool"
          );
        }
      });

      // increaseUSDD
      it("increaseUSDDDebt(): reverts when called by an account that is not BO nor TroveM", async () => {
        // Attempt call from alice
        try {
          const txAlice = await activePool.increaseUSDDDebt(100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is neither BorrowerOperations nor TroveManager");
        }
      });

      // decreaseUSDD
      it("decreaseUSDDDebt(): reverts when called by an account that is not BO nor TroveM nor SP", async () => {
        // Attempt call from alice
        try {
          const txAlice = await activePool.decreaseUSDDDebt(100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(
            err.message,
            "Caller is neither BorrowerOperations nor TroveManager nor StabilityPool"
          );
        }
      });

      // fallback (payment)
      it("fallback(): reverts when called by an account that is not Borrower Operations nor Default Pool", async () => {
        // Attempt call from alice
        try {
          const txAlice = await activePool.receiveColl(collToken.address, toBN(100));
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "ActivePool: Caller is neither BO nor Default Pool");
        }
      });
    });

    describe("DefaultPool", async accounts => {
      // sendETHToActivePool
      it("sendETHToActivePool(): reverts when called by an account that is not TroveManager", async () => {
        // Attempt call from alice
        try {
          const txAlice = await defaultPool.sendToActivePool(collToken.address, 100, {
            from: alice
          });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is not the TroveManager");
        }
      });

      // increaseUSDD
      it("increaseUSDDDebt(): reverts when called by an account that is not TroveManager", async () => {
        // Attempt call from alice
        try {
          const txAlice = await defaultPool.increaseUSDDDebt(100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is not the TroveManager");
        }
      });

      // decreaseUSDD
      it("decreaseUSDD(): reverts when called by an account that is not TroveManager", async () => {
        // Attempt call from alice
        try {
          const txAlice = await defaultPool.decreaseUSDDDebt(100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is not the TroveManager");
        }
      });

      // fallback (payment)
      it("fallback(): reverts when called by an account that is not the Active Pool", async () => {
        // Attempt call from alice
        try {
          const txAlice = await defaultPool.receiveColl(collToken.address, toBN(100));
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "DefaultPool: Caller is not the TroveManager");
        }
      });
    });

    describe("StabilityPool", async accounts => {
      // --- onlyTroveManager ---

      // offset
      it("offset(): reverts when called by an account that is not TroveManager", async () => {
        // Attempt call from alice
        try {
          txAlice = await stabilityPool.offset(100, 10, { from: alice });
          assert.fail(txAlice);
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is not TroveManager");
        }
      });

      // --- onlyActivePool ---

      // fallback (payment)
      // it("fallback(): reverts when called by an account that is not the Active Pool", async () => {
      //   // Attempt call from alice
      //   try {
      //     const txAlice = await web3.eth.sendTransaction({
      //       from: alice,
      //       to: stabilityPool.address,
      //       value: 100
      //     });
      //   } catch (err) {
      //     assert.include(err.message, "revert");
      //     assert.include(err.message, "StabilityPool: Caller is not ActivePool");
      //   }
      // });
    });

    describe("USDDToken", async accounts => {
      //    mint
      it("mint(): reverts when called by an account that is not BorrowerOperations", async () => {
        // Attempt call from alice
        const txAlice = usddToken.mint(bob, 100, { from: alice });
        await th.assertRevert(txAlice, "Caller is not BorrowerOperations");
      });

      // burn
      it("burn(): reverts when called by an account that is not BO nor TroveM nor SP", async () => {
        // Attempt call from alice
        try {
          const txAlice = await usddToken.burn(bob, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is neither BorrowerOperations nor TroveManager nor StabilityPool")
        }
      });

      // sendToPool
      it("sendToPool(): reverts when called by an account that is not StabilityPool", async () => {
        // Attempt call from alice
        try {
          const txAlice = await usddToken.sendToPool(bob, activePool.address, 100, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is not the StabilityPool");
        }
      });

      // returnFromPool
      it("returnFromPool(): reverts when called by an account that is not TroveManager nor StabilityPool", async () => {
        // Attempt call from alice
        try {
          const txAlice = await usddToken.returnFromPool(activePool.address, bob, 100, {
            from: alice
          });
        } catch (err) {
          assert.include(err.message, "revert");
          // assert.include(err.message, "Caller is neither TroveManager nor StabilityPool")
        }
      });
    });

    describe("SortedTroves", async accounts => {
      // --- onlyBorrowerOperations ---
      //     insert
      it("insert(): reverts when called by an account that is not BorrowerOps or TroveM", async () => {
        // Attempt call from alice
        try {
          const txAlice = await sortedTroves.insert(bob, "150000000000000000000", bob, bob, {
            from: alice
          });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, " Caller is neither BO nor TroveM");
        }
      });

      // --- onlyTroveManager ---
      // remove
      it("remove(): reverts when called by an account that is not TroveManager", async () => {
        // Attempt call from alice
        try {
          const txAlice = await sortedTroves.remove(bob, { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, " Caller is not the TroveManager");
        }
      });

      // --- onlyTroveMorBM ---
      // reinsert
      it("reinsert(): reverts when called by an account that is neither BorrowerOps nor TroveManager", async () => {
        // Attempt call from alice
        try {
          const txAlice = await sortedTroves.reInsert(bob, "150000000000000000000", bob, bob, {
            from: alice
          });
        } catch (err) {
          assert.include(err.message, "revert");
          assert.include(err.message, "Caller is neither BO nor TroveM");
        }
      });
    });

    describe("DEFTStaking", async accounts => {
      it("increaseF_USDD(): reverts when caller is not TroveManager", async () => {
        try {
          const txAlice = await deftStaking.increaseF_USDD(dec(1, 18), { from: alice });
        } catch (err) {
          assert.include(err.message, "revert");
        }
      });
    });

    describe("CommunityIssuance", async accounts => {
      it("sendDEFT(): reverts when caller is not the StabilityPool", async () => {
        const tx1 = communityIssuance.sendDEFT(alice, dec(100, 18), { from: alice });
        const tx2 = communityIssuance.sendDEFT(bob, dec(100, 18), { from: alice });
        const tx3 = communityIssuance.sendDEFT(stabilityPool.address, dec(100, 18), { from: alice });

        assertRevert(tx1);
        assertRevert(tx2);
        assertRevert(tx3);
      });

      it("issueDEFT(): reverts when caller is not the StabilityPool", async () => {
        const tx1 = communityIssuance.issueDEFT({ from: alice });

        assertRevert(tx1);
      });
    });
  }
);
