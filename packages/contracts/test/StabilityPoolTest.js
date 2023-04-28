const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");
const { BNConverter } = require("../utils/BNConverter.js");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const mv = testHelpers.MoneyValues;
const timeValues = testHelpers.TimeValues;

const TroveManagerTester = artifacts.require("TroveManagerTester");
const USDDToken = artifacts.require("USDDToken");
const NonPayable = artifacts.require("NonPayable.sol");

const ZERO = toBN("0");
const ZERO_ADDRESS = th.ZERO_ADDRESS;
const maxBytes32 = th.maxBytes32;

const getFrontEndTag = async (stabilityPool, depositor) => {
  return (await stabilityPool.deposits(depositor))[1];
};

contract("StabilityPool", async accounts => {
  const [
    owner,
    defaulter_1,
    defaulter_2,
    defaulter_3,
    whale,
    alice,
    bob,
    carol,
    dennis,
    erin,
    flyn,
    A,
    B,
    C,
    D,
    E,
    F,
    frontEnd_1,
    frontEnd_2,
    frontEnd_3
  ] = accounts;

  const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3];
  let contracts;
  let priceFeed;
  let usddToken;
  let sortedTroves;
  let troveManager;
  let activePool;
  let stabilityPool;
  let defaultPool;
  let borrowerOperations;
  let deftToken;
  let communityIssuance;
  let collToken;

  let gasPriceInWei;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);
  const openTrove = async params => th.openTrove(contracts, params);
  const assertRevert = th.assertRevert;

  describe("Stability Pool Mechanisms", async () => {
    before(async () => {
      gasPriceInWei = await web3.eth.getGasPrice();
    });

    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore();
      contracts.troveManager = await TroveManagerTester.new();
      contracts.usddToken = await USDDToken.new(
        contracts.troveManager.address,
        contracts.stabilityPool.address,
        contracts.borrowerOperations.address
      );
      const DEFTContracts = await deploymentHelper.deployDEFTContracts();

      priceFeed = contracts.priceFeedTestnet;
      usddToken = contracts.usddToken;
      sortedTroves = contracts.sortedTroves;
      troveManager = contracts.troveManager;
      activePool = contracts.activePool;
      stabilityPool = contracts.stabilityPool;
      defaultPool = contracts.defaultPool;
      borrowerOperations = contracts.borrowerOperations;
      hintHelpers = contracts.hintHelpers;
      collToken = contracts.weth;

      deftToken = DEFTContracts.deftToken;
      communityIssuance = DEFTContracts.communityIssuance;

      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

      const issuanceCap = BNConverter.makeBN18(32000000);
      deftToken.mint(communityIssuance.address, issuanceCap);
      await communityIssuance.start(issuanceCap);

      // Register 3 front ends
      await th.registerFrontEnds(frontEnds, stabilityPool);
    });

    // --- provideToSP() ---
    // increases recorded USDD at Stability Pool
    it("provideToSP(): increases the Stability Pool USDD balance", async () => {
      // --- SETUP --- Give Alice a least 200
      await openTrove({
        extraUSDDAmount: toBN(200),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // --- TEST ---

      // provideToSP()
      await stabilityPool.provideToSP(200, ZERO_ADDRESS, { from: alice });

      // check USDD balances after
      const stabilityPool_USDD_After = await stabilityPool.getTotalUSDDDeposits();
      assert.equal(stabilityPool_USDD_After, 200);
    });

    it("provideToSP(): updates the user's deposit record in StabilityPool", async () => {
      // --- SETUP --- Give Alice a least 200
      await openTrove({
        extraUSDDAmount: toBN(200),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // --- TEST ---
      // check user's deposit record before
      const alice_depositRecord_Before = await stabilityPool.deposits(alice);
      assert.equal(alice_depositRecord_Before[0], 0);

      // provideToSP()
      await stabilityPool.provideToSP(200, frontEnd_1, { from: alice });

      // check user's deposit record after
      const alice_depositRecord_After = (await stabilityPool.deposits(alice))[0];
      assert.equal(alice_depositRecord_After, 200);
    });

    it("provideToSP(): reduces the user's USDD balance by the correct amount", async () => {
      // --- SETUP --- Give Alice a least 200
      await openTrove({
        extraUSDDAmount: toBN(200),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // --- TEST ---
      // get user's deposit record before
      const alice_USDDBalance_Before = await usddToken.balanceOf(alice);

      // provideToSP()
      await stabilityPool.provideToSP(200, frontEnd_1, { from: alice });

      // check user's USDD balance change
      const alice_USDDBalance_After = await usddToken.balanceOf(alice);
      assert.equal(alice_USDDBalance_Before.sub(alice_USDDBalance_After), "200");
    });

    it("provideToSP(): increases totalUSDDDeposits by correct amount", async () => {
      // --- SETUP ---

      // Whale opens Trove with 50 ETH, adds 2000 USDD to StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_1, { from: whale });

      const totalUSDDDeposits = await stabilityPool.getTotalUSDDDeposits();
      assert.equal(totalUSDDDeposits, dec(2000, 18));
    });

    it("provideToSP(): Correctly updates user snapshots of accumulated rewards per unit staked", async () => {
      // --- SETUP ---

      // Whale opens Trove and deposits to SP
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });
      const whaleUSDD = await usddToken.balanceOf(whale);
      await stabilityPool.provideToSP(whaleUSDD, frontEnd_1, { from: whale });

      // 2 Troves opened, each withdraws minimum debt
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_2 }
      });

      // Alice makes Trove and withdraws 100 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(5, 18)),
        extraParams: { from: alice, value: dec(50, "ether") }
      });

      // price drops: defaulter's Troves fall below MCR, whale doesn't
      await priceFeed.setPrice(dec(105, 18));

      const SPUSDD_Before = await stabilityPool.getTotalUSDDDeposits();

      // Troves are closed
      await troveManager.liquidate(defaulter_1, { from: owner });
      await troveManager.liquidate(defaulter_2, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      // Confirm SP has decreased
      const SPUSDD_After = await stabilityPool.getTotalUSDDDeposits();
      assert.isTrue(SPUSDD_After.lt(SPUSDD_Before));

      // --- TEST ---
      const P_Before = await stabilityPool.P();
      const S_Before = await stabilityPool.epochToScaleToSum(0, 0);
      const G_Before = await stabilityPool.epochToScaleToG(0, 0);
      assert.isTrue(P_Before.gt(toBN("0")));
      assert.isTrue(S_Before.gt(toBN("0")));

      // Check 'Before' snapshots
      const alice_snapshot_Before = await stabilityPool.depositSnapshots(alice);
      const alice_snapshot_S_Before = alice_snapshot_Before[0].toString();
      const alice_snapshot_P_Before = alice_snapshot_Before[1].toString();
      const alice_snapshot_G_Before = alice_snapshot_Before[2].toString();
      assert.equal(alice_snapshot_S_Before, "0");
      assert.equal(alice_snapshot_P_Before, "0");
      assert.equal(alice_snapshot_G_Before, "0");

      // Make deposit
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });

      // Check 'After' snapshots
      const alice_snapshot_After = await stabilityPool.depositSnapshots(alice);
      const alice_snapshot_S_After = alice_snapshot_After[0].toString();
      const alice_snapshot_P_After = alice_snapshot_After[1].toString();
      const alice_snapshot_G_After = alice_snapshot_After[2].toString();

      assert.equal(alice_snapshot_S_After, S_Before);
      assert.equal(alice_snapshot_P_After, P_Before);
      assert.equal(alice_snapshot_G_After, G_Before);
    });

    it("provideToSP(), multiple deposits: updates user's deposit and snapshots", async () => {
      // --- SETUP ---
      // Whale opens Trove and deposits to SP
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });
      const whaleUSDD = await usddToken.balanceOf(whale);
      await stabilityPool.provideToSP(whaleUSDD, frontEnd_1, { from: whale });

      // 3 Troves opened. Two users withdraw 160 USDD each
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1, value: dec(50, "ether") }
      });
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_2, value: dec(50, "ether") }
      });
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_3, value: dec(50, "ether") }
      });

      // --- TEST ---

      // Alice makes deposit #1: 150 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(250, 18)),
        ICR: toBN(dec(3, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(150, 18), frontEnd_1, { from: alice });

      const alice_Snapshot_0 = await stabilityPool.depositSnapshots(alice);
      const alice_Snapshot_S_0 = alice_Snapshot_0[0];
      const alice_Snapshot_P_0 = alice_Snapshot_0[1];
      assert.equal(alice_Snapshot_S_0, 0);
      assert.equal(alice_Snapshot_P_0, "1000000000000000000");

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // 2 users with Trove with 180 USDD drawn are closed
      await troveManager.liquidate(defaulter_1, { from: owner }); // 180 USDD closed
      await troveManager.liquidate(defaulter_2, { from: owner }); // 180 USDD closed

      const alice_compoundedDeposit_1 = await stabilityPool.getCompoundedUSDDDeposit(alice);

      // Alice makes deposit #2
      const alice_topUp_1 = toBN(dec(100, 18));
      await stabilityPool.provideToSP(alice_topUp_1, frontEnd_1, { from: alice });

      const alice_newDeposit_1 = (await stabilityPool.deposits(alice))[0].toString();
      assert.equal(alice_compoundedDeposit_1.add(alice_topUp_1), alice_newDeposit_1);

      // get system reward terms
      const P_1 = await stabilityPool.P();
      const S_1 = await stabilityPool.epochToScaleToSum(0, 0);
      assert.isTrue(P_1.lt(toBN(dec(1, 18))));
      assert.isTrue(S_1.gt(toBN("0")));

      // check Alice's new snapshot is correct
      const alice_Snapshot_1 = await stabilityPool.depositSnapshots(alice);
      const alice_Snapshot_S_1 = alice_Snapshot_1[0];
      const alice_Snapshot_P_1 = alice_Snapshot_1[1];
      assert.isTrue(alice_Snapshot_S_1.eq(S_1));
      assert.isTrue(alice_Snapshot_P_1.eq(P_1));

      // Bob withdraws USDD and deposits to StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await stabilityPool.provideToSP(dec(427, 18), frontEnd_1, { from: alice });

      // Defaulter 3 Trove is closed
      await troveManager.liquidate(defaulter_3, { from: owner });

      const alice_compoundedDeposit_2 = await stabilityPool.getCompoundedUSDDDeposit(alice);

      const P_2 = await stabilityPool.P();
      const S_2 = await stabilityPool.epochToScaleToSum(0, 0);
      assert.isTrue(P_2.lt(P_1));
      assert.isTrue(S_2.gt(S_1));

      // Alice makes deposit #3:  100USDD
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });

      // check Alice's new snapshot is correct
      const alice_Snapshot_2 = await stabilityPool.depositSnapshots(alice);
      const alice_Snapshot_S_2 = alice_Snapshot_2[0];
      const alice_Snapshot_P_2 = alice_Snapshot_2[1];
      assert.isTrue(alice_Snapshot_S_2.eq(S_2));
      assert.isTrue(alice_Snapshot_P_2.eq(P_2));
    });

    it("provideToSP(): reverts if user tries to provide more than their USDD balance", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice, value: dec(50, "ether") }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob, value: dec(50, "ether") }
      });
      const aliceUSDDbal = await usddToken.balanceOf(alice);
      const bobUSDDbal = await usddToken.balanceOf(bob);

      // Alice, attempts to deposit 1 wei more than her balance

      const aliceTxPromise = stabilityPool.provideToSP(aliceUSDDbal.add(toBN(1)), frontEnd_1, {
        from: alice
      });
      await assertRevert(aliceTxPromise, "revert");

      // Bob, attempts to deposit 235534 more than his balance

      const bobTxPromise = stabilityPool.provideToSP(
        bobUSDDbal.add(toBN(dec(235534, 18))),
        frontEnd_1,
        { from: bob }
      );
      await assertRevert(bobTxPromise, "revert");
    });

    it("provideToSP(): reverts if user tries to provide 2^256-1 USDD, which exceeds their balance", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice, value: dec(50, "ether") }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob, value: dec(50, "ether") }
      });

      const maxBytes32 = web3.utils.toBN(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      );

      // Alice attempts to deposit 2^256-1 USDD
      try {
        aliceTx = await stabilityPool.provideToSP(maxBytes32, frontEnd_1, { from: alice });
        assert.isFalse(tx.receipt.status);
      } catch (error) {
        assert.include(error.message, "revert");
      }
    });

    // it("provideToSP(): reverts if cannot receive ETH Gain", async () => {
    //   // --- SETUP ---
    //   // Whale deposits 1850 USDD in StabilityPool
    //   await openTrove({ extraUSDDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, value: dec(50, 'ether') } })
    //   await stabilityPool.provideToSP(dec(1850, 18), frontEnd_1, { from: whale })

    //   // Defaulter Troves opened
    //   await openTrove({ extraUSDDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
    //   await openTrove({ extraUSDDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

    //   // --- TEST ---

    //   const nonPayable = await NonPayable.new()
    //   await usddToken.transfer(nonPayable.address, dec(250, 18), { from: whale })

    //   // NonPayable makes deposit #1: 150 USDD
    //   const txData1 = th.getTransactionData('provideToSP(uint256,address)', [web3.utils.toHex(dec(150, 18)), frontEnd_1])
    //   const tx1 = await nonPayable.forward(stabilityPool.address, txData1)

    //   const gain_0 = await stabilityPool.getDepositorCollGain(nonPayable.address)
    //   assert.isTrue(gain_0.eq(toBN(0)), 'NonPayable should not have accumulated gains')

    //   // price drops: defaulters' Troves fall below MCR, nonPayable and whale Trove remain active
    //   await priceFeed.setPrice(dec(105, 18));

    //   // 2 defaulters are closed
    //   await troveManager.liquidate(defaulter_1, { from: owner })
    //   await troveManager.liquidate(defaulter_2, { from: owner })

    //   const gain_1 = await stabilityPool.getDepositorCollGain(nonPayable.address)
    //   assert.isTrue(gain_1.gt(toBN(0)), 'NonPayable should have some accumulated gains')

    //   // NonPayable tries to make deposit #2: 100USDD (which also attempts to withdraw ETH gain)
    //   const txData2 = th.getTransactionData('provideToSP(uint256,address)', [web3.utils.toHex(dec(100, 18)), frontEnd_1])
    //   await th.assertRevert(nonPayable.forward(stabilityPool.address, txData2), 'StabilityPool: sending ETH failed')
    // })

    it("provideToSP(): doesn't impact other users' deposits or ETH gains", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_1, { from: carol });

      // D opens a trove
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      // Would-be defaulters open troves
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_2 }
      });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      // Defaulters are liquidated
      await troveManager.liquidate(defaulter_1);
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      const alice_USDDDeposit_Before = (
        await stabilityPool.getCompoundedUSDDDeposit(alice)
      ).toString();
      const bob_USDDDeposit_Before = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();
      const carol_USDDDeposit_Before = (
        await stabilityPool.getCompoundedUSDDDeposit(carol)
      ).toString();

      const alice_ETHGain_Before = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_Before = (await stabilityPool.getDepositorCollGain(bob)).toString();
      const carol_ETHGain_Before = (await stabilityPool.getDepositorCollGain(carol)).toString();

      //check non-zero USDD and ETHGain in the Stability Pool
      const USDDinSP = await stabilityPool.getTotalUSDDDeposits();
      const ETHinSP = await stabilityPool.getColl();
      assert.isTrue(USDDinSP.gt(mv._zeroBN));
      assert.isTrue(ETHinSP.gt(mv._zeroBN));

      // D makes an SP deposit
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: dennis });
      assert.equal((await stabilityPool.getCompoundedUSDDDeposit(dennis)).toString(), dec(1000, 18));

      const alice_USDDDeposit_After = (
        await stabilityPool.getCompoundedUSDDDeposit(alice)
      ).toString();
      const bob_USDDDeposit_After = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();
      const carol_USDDDeposit_After = (
        await stabilityPool.getCompoundedUSDDDeposit(carol)
      ).toString();

      const alice_ETHGain_After = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_After = (await stabilityPool.getDepositorCollGain(bob)).toString();
      const carol_ETHGain_After = (await stabilityPool.getDepositorCollGain(carol)).toString();

      // Check compounded deposits and ETH gains for A, B and C have not changed
      assert.equal(alice_USDDDeposit_Before, alice_USDDDeposit_After);
      assert.equal(bob_USDDDeposit_Before, bob_USDDDeposit_After);
      assert.equal(carol_USDDDeposit_Before, carol_USDDDeposit_After);

      assert.equal(alice_ETHGain_Before, alice_ETHGain_After);
      assert.equal(bob_ETHGain_Before, bob_ETHGain_After);
      assert.equal(carol_ETHGain_Before, carol_ETHGain_After);
    });

    it("provideToSP(): doesn't impact system debt, collateral or TCR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_1, { from: carol });

      // D opens a trove
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      // Would-be defaulters open troves
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });
      await openTrove({
        extraUSDDAmount: 0,
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_2 }
      });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      // Defaulters are liquidated
      await troveManager.liquidate(defaulter_1);
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      const activeDebt_Before = (await activePool.getUSDDDebt()).toString();
      const defaultedDebt_Before = (await defaultPool.getUSDDDebt()).toString();
      const activeColl_Before = (await activePool.getColl(collToken.address)).toString();
      const defaultedColl_Before = (await defaultPool.getColl(collToken.address)).toString();
      const TCR_Before = (await th.getTCR(contracts)).toString();

      // D makes an SP deposit
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: dennis });
      assert.equal((await stabilityPool.getCompoundedUSDDDeposit(dennis)).toString(), dec(1000, 18));

      const activeDebt_After = (await activePool.getUSDDDebt()).toString();
      const defaultedDebt_After = (await defaultPool.getUSDDDebt()).toString();
      const activeColl_After = (await activePool.getColl(collToken.address)).toString();
      const defaultedColl_After = (await defaultPool.getColl(collToken.address)).toString();
      const TCR_After = (await th.getTCR(contracts)).toString();

      // Check total system debt, collateral and TCR have not changed after a Stability deposit is made
      assert.equal(activeDebt_Before, activeDebt_After);
      assert.equal(defaultedDebt_Before, defaultedDebt_After);
      assert.equal(activeColl_Before, activeColl_After);
      assert.equal(defaultedColl_Before, defaultedColl_After);
      assert.equal(TCR_Before, TCR_After);
    });

    it("provideToSP(): doesn't impact any troves, including the caller's trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A and B provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_1, { from: bob });

      // D opens a trove
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();

      // Get debt, collateral and ICR of all existing troves
      const whale_Debt_Before = (await troveManager.Troves(whale))[0].toString();
      const alice_Debt_Before = (await troveManager.Troves(alice))[0].toString();
      const bob_Debt_Before = (await troveManager.Troves(bob))[0].toString();
      const carol_Debt_Before = (await troveManager.Troves(carol))[0].toString();
      const dennis_Debt_Before = (await troveManager.Troves(dennis))[0].toString();

      const whale_Coll_Before = (await troveManager.Troves(whale))[1].toString();
      const alice_Coll_Before = (await troveManager.Troves(alice))[1].toString();
      const bob_Coll_Before = (await troveManager.Troves(bob))[1].toString();
      const carol_Coll_Before = (await troveManager.Troves(carol))[1].toString();
      const dennis_Coll_Before = (await troveManager.Troves(dennis))[1].toString();

      const whale_ICR_Before = (await troveManager.getCurrentICR(whale, price)).toString();
      const alice_ICR_Before = (await troveManager.getCurrentICR(alice, price)).toString();
      const bob_ICR_Before = (await troveManager.getCurrentICR(bob, price)).toString();
      const carol_ICR_Before = (await troveManager.getCurrentICR(carol, price)).toString();
      const dennis_ICR_Before = (await troveManager.getCurrentICR(dennis, price)).toString();

      // D makes an SP deposit
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: dennis });
      assert.equal((await stabilityPool.getCompoundedUSDDDeposit(dennis)).toString(), dec(1000, 18));

      const whale_Debt_After = (await troveManager.Troves(whale))[0].toString();
      const alice_Debt_After = (await troveManager.Troves(alice))[0].toString();
      const bob_Debt_After = (await troveManager.Troves(bob))[0].toString();
      const carol_Debt_After = (await troveManager.Troves(carol))[0].toString();
      const dennis_Debt_After = (await troveManager.Troves(dennis))[0].toString();

      const whale_Coll_After = (await troveManager.Troves(whale))[1].toString();
      const alice_Coll_After = (await troveManager.Troves(alice))[1].toString();
      const bob_Coll_After = (await troveManager.Troves(bob))[1].toString();
      const carol_Coll_After = (await troveManager.Troves(carol))[1].toString();
      const dennis_Coll_After = (await troveManager.Troves(dennis))[1].toString();

      const whale_ICR_After = (await troveManager.getCurrentICR(whale, price)).toString();
      const alice_ICR_After = (await troveManager.getCurrentICR(alice, price)).toString();
      const bob_ICR_After = (await troveManager.getCurrentICR(bob, price)).toString();
      const carol_ICR_After = (await troveManager.getCurrentICR(carol, price)).toString();
      const dennis_ICR_After = (await troveManager.getCurrentICR(dennis, price)).toString();

      assert.equal(whale_Debt_Before, whale_Debt_After);
      assert.equal(alice_Debt_Before, alice_Debt_After);
      assert.equal(bob_Debt_Before, bob_Debt_After);
      assert.equal(carol_Debt_Before, carol_Debt_After);
      assert.equal(dennis_Debt_Before, dennis_Debt_After);

      assert.equal(whale_Coll_Before, whale_Coll_After);
      assert.equal(alice_Coll_Before, alice_Coll_After);
      assert.equal(bob_Coll_Before, bob_Coll_After);
      assert.equal(carol_Coll_Before, carol_Coll_After);
      assert.equal(dennis_Coll_Before, dennis_Coll_After);

      assert.equal(whale_ICR_Before, whale_ICR_After);
      assert.equal(alice_ICR_Before, alice_ICR_After);
      assert.equal(bob_ICR_Before, bob_ICR_After);
      assert.equal(carol_ICR_Before, carol_ICR_After);
      assert.equal(dennis_ICR_Before, dennis_ICR_After);
    });

    it("provideToSP(): doesn't protect the depositor's trove from liquidation", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A, B provide 100 USDD to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: bob });

      // Confirm Bob has an active trove in the system
      assert.isTrue(await sortedTroves.contains(bob));
      assert.equal((await troveManager.getTroveStatus(bob)).toString(), "1"); // Confirm Bob's trove status is active

      // Confirm Bob has a Stability deposit
      assert.equal((await stabilityPool.getCompoundedUSDDDeposit(bob)).toString(), dec(1000, 18));

      // Price drops
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();

      // Liquidate bob
      await troveManager.liquidate(bob);

      // Check Bob's trove has been removed from the system
      assert.isFalse(await sortedTroves.contains(bob));
      assert.equal((await troveManager.getTroveStatus(bob)).toString(), "3"); // check Bob's trove status was closed by liquidation
    });

    it("provideToSP(): providing 0 USDD reverts", async () => {
      // --- SETUP ---
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A, B, C provides 100, 50, 30 USDD to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(50, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_1, { from: carol });

      const bob_Deposit_Before = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();
      const USDDinSP_Before = (await stabilityPool.getTotalUSDDDeposits()).toString();

      assert.equal(USDDinSP_Before, dec(180, 18));

      // Bob provides 0 USDD to the Stability Pool
      const txPromise_B = stabilityPool.provideToSP(0, frontEnd_1, { from: bob });
      await th.assertRevert(txPromise_B);
    });

    // --- DEFT functionality ---
    it("provideToSP(), new deposit: when SP > 0, triggers DEFT reward event - increases the sum G", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A provides to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });

      let currentEpoch = await stabilityPool.currentEpoch();
      let currentScale = await stabilityPool.currentScale();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // B provides to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: B });

      currentEpoch = await stabilityPool.currentEpoch();
      currentScale = await stabilityPool.currentScale();
      const G_After = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Expect G has increased from the DEFT reward event triggered
      assert.isTrue(G_After.gt(G_Before));
    });

    it("provideToSP(), new deposit: when SP is empty, doesn't update G", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A provides to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A withdraws
      await stabilityPool.withdrawFromSP(dec(1000, 18), { from: A });

      // Check SP is empty
      assert.equal(await stabilityPool.getTotalUSDDDeposits(), "0");

      // Check G is non-zero
      let currentEpoch = await stabilityPool.currentEpoch();
      let currentScale = await stabilityPool.currentScale();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      assert.isTrue(G_Before.gt(toBN("0")));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // B provides to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: B });

      currentEpoch = await stabilityPool.currentEpoch();
      currentScale = await stabilityPool.currentScale();
      const G_After = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Expect G has not changed
      assert.isTrue(G_After.eq(G_Before));
    });

    it("provideToSP(), new deposit: sets the correct front end tag", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, C, D open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check A, B, C D have no front end tags
      const A_tagBefore = await getFrontEndTag(stabilityPool, A);
      const B_tagBefore = await getFrontEndTag(stabilityPool, B);
      const C_tagBefore = await getFrontEndTag(stabilityPool, C);
      const D_tagBefore = await getFrontEndTag(stabilityPool, D);

      assert.equal(A_tagBefore, ZERO_ADDRESS);
      assert.equal(B_tagBefore, ZERO_ADDRESS);
      assert.equal(C_tagBefore, ZERO_ADDRESS);
      assert.equal(D_tagBefore, ZERO_ADDRESS);

      // A, B, C, D provides to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: C });
      await stabilityPool.provideToSP(dec(4000, 18), ZERO_ADDRESS, { from: D }); // transacts directly, no front end

      // Check A, B, C D have no front end tags
      const A_tagAfter = await getFrontEndTag(stabilityPool, A);
      const B_tagAfter = await getFrontEndTag(stabilityPool, B);
      const C_tagAfter = await getFrontEndTag(stabilityPool, C);
      const D_tagAfter = await getFrontEndTag(stabilityPool, D);

      // Check front end tags are correctly set
      assert.equal(A_tagAfter, frontEnd_1);
      assert.equal(B_tagAfter, frontEnd_2);
      assert.equal(C_tagAfter, frontEnd_3);
      assert.equal(D_tagAfter, ZERO_ADDRESS);
    });

    it("provideToSP(), new deposit: depositor does not receive any DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: dec(50, "ether") }
      });

      // A, B, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      // Get A, B, C DEFT balances before and confirm they're zero
      const A_DEFTBalance_Before = await deftToken.balanceOf(A);
      const B_DEFTBalance_Before = await deftToken.balanceOf(B);

      assert.equal(A_DEFTBalance_Before, "0");
      assert.equal(B_DEFTBalance_Before, "0");

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A, B provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), ZERO_ADDRESS, { from: B });

      // Get A, B, C DEFT balances after, and confirm they're still zero
      const A_DEFTBalance_After = await deftToken.balanceOf(A);
      const B_DEFTBalance_After = await deftToken.balanceOf(B);

      assert.equal(A_DEFTBalance_After, "0");
      assert.equal(B_DEFTBalance_After, "0");
    });

    it("provideToSP(), new deposit after past full withdrawal: depositor does not receive any DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(4000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---

      const initialDeposit_A = await usddToken.balanceOf(A);
      const initialDeposit_B = await usddToken.balanceOf(B);
      // A, B provide to SP
      await stabilityPool.provideToSP(initialDeposit_A, frontEnd_1, { from: A });
      await stabilityPool.provideToSP(initialDeposit_B, frontEnd_2, { from: B });

      // time passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // C deposits. A, and B earn DEFT
      await stabilityPool.provideToSP(dec(5, 18), ZERO_ADDRESS, { from: C });

      // Price drops, defaulter is liquidated, A, B and C earn ETH
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      // price bounces back to 200
      await priceFeed.setPrice(dec(200, 18));

      // A and B fully withdraw from the pool
      await stabilityPool.withdrawFromSP(initialDeposit_A, { from: A });
      await stabilityPool.withdrawFromSP(initialDeposit_B, { from: B });

      // --- TEST ---

      // Get A, B, C DEFT balances before and confirm they're non-zero
      const A_DEFTBalance_Before = await deftToken.balanceOf(A);
      const B_DEFTBalance_Before = await deftToken.balanceOf(B);
      assert.isTrue(A_DEFTBalance_Before.gt(toBN("0")));
      assert.isTrue(B_DEFTBalance_Before.gt(toBN("0")));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A, B provide to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: B });

      // Get A, B, C DEFT balances after, and confirm they have not changed
      const A_DEFTBalance_After = await deftToken.balanceOf(A);
      const B_DEFTBalance_After = await deftToken.balanceOf(B);

      assert.isTrue(A_DEFTBalance_After.eq(A_DEFTBalance_Before));
      assert.isTrue(B_DEFTBalance_After.eq(B_DEFTBalance_Before));
    });

    it("provideToSP(), new eligible deposit: tagged front end receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: F }
      });

      // D, E, F provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: E });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: F });

      // Get F1, F2, F3 DEFT balances before, and confirm they're zero
      const frontEnd_1_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_1);
      const frontEnd_2_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_2);
      const frontEnd_3_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_3);

      assert.equal(frontEnd_1_DEFTBalance_Before, "0");
      assert.equal(frontEnd_2_DEFTBalance_Before, "0");
      assert.equal(frontEnd_3_DEFTBalance_Before, "0");

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // console.log(`DEFTSupplyCap before: ${await communityIssuance.DEFTSupplyCap()}`)
      // console.log(`totalDEFTIssued before: ${await communityIssuance.totalDEFTIssued()}`)
      // console.log(`DEFT balance of CI before: ${await deftToken.balanceOf(communityIssuance.address)}`)

      // A, B, C provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: C });

      // console.log(`DEFTSupplyCap after: ${await communityIssuance.DEFTSupplyCap()}`)
      // console.log(`totalDEFTIssued after: ${await communityIssuance.totalDEFTIssued()}`)
      // console.log(`DEFT balance of CI after: ${await deftToken.balanceOf(communityIssuance.address)}`)

      // Get F1, F2, F3 DEFT balances after, and confirm they have increased
      const frontEnd_1_DEFTBalance_After = await deftToken.balanceOf(frontEnd_1);
      const frontEnd_2_DEFTBalance_After = await deftToken.balanceOf(frontEnd_2);
      const frontEnd_3_DEFTBalance_After = await deftToken.balanceOf(frontEnd_3);

      assert.isTrue(frontEnd_1_DEFTBalance_After.gt(frontEnd_1_DEFTBalance_Before));
      assert.isTrue(frontEnd_2_DEFTBalance_After.gt(frontEnd_2_DEFTBalance_Before));
      assert.isTrue(frontEnd_3_DEFTBalance_After.gt(frontEnd_3_DEFTBalance_Before));
    });

    it("provideToSP(), new eligible deposit: tagged front end's stake increases", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Get front ends' stakes before
      const F1_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_3);

      const deposit_A = dec(1000, 18);
      const deposit_B = dec(2000, 18);
      const deposit_C = dec(3000, 18);

      // A, B, C provide to SP
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      // Get front ends' stakes after
      const F1_Stake_After = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_After = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_After = await stabilityPool.frontEndStakes(frontEnd_3);

      const F1_Diff = F1_Stake_After.sub(F1_Stake_Before);
      const F2_Diff = F2_Stake_After.sub(F2_Stake_Before);
      const F3_Diff = F3_Stake_After.sub(F3_Stake_Before);

      // Check front ends' stakes have increased by amount equal to the deposit made through them
      assert.equal(F1_Diff, deposit_A);
      assert.equal(F2_Diff, deposit_B);
      assert.equal(F3_Diff, deposit_C);
    });

    it("provideToSP(), new eligible deposit: tagged front end's snapshots update", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(4000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---

      await stabilityPool.provideToSP(dec(2000, 18), ZERO_ADDRESS, { from: D });

      // fastforward time then  make an SP deposit, to make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await stabilityPool.provideToSP(dec(2000, 18), ZERO_ADDRESS, { from: D });

      // Perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // Get front ends' snapshots before
      for (frontEnd of [frontEnd_1, frontEnd_2, frontEnd_3]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends, since S corresponds to ETH gain)
        assert.equal(snapshot[1], "0"); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      const deposit_A = dec(1000, 18);
      const deposit_B = dec(2000, 18);
      const deposit_C = dec(3000, 18);

      // --- TEST ---

      // A, B, C provide to SP
      const G1 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });

      const G2 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });

      const G3 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3];
      const G_Values = [G1, G2, G3];

      // Map frontEnds to the value of G at time the deposit was made
      frontEndToG = th.zipToObject(frontEnds, G_Values);

      // Get front ends' snapshots after
      for (const [frontEnd, G] of Object.entries(frontEndToG)) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        // Check snapshots are the expected values
        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends)
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].eq(G)); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("provideToSP(), new deposit: depositor does not receive ETH gains", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // Whale transfers USDD to A, B
      await usddToken.transfer(A, dec(100, 18), { from: whale });
      await usddToken.transfer(B, dec(200, 18), { from: whale });

      // C, D open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // --- TEST ---

      // get current ETH balances
      const A_ETHBalance_Before = await web3.eth.getBalance(A);
      const B_ETHBalance_Before = await web3.eth.getBalance(B);
      const C_ETHBalance_Before = await web3.eth.getBalance(C);
      const D_ETHBalance_Before = await web3.eth.getBalance(D);

      // A, B, C, D provide to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: B, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(300, 18), frontEnd_2, { from: C, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(400, 18), ZERO_ADDRESS, { from: D, gasPrice: 0 });

      // Get  ETH balances after
      const A_ETHBalance_After = await web3.eth.getBalance(A);
      const B_ETHBalance_After = await web3.eth.getBalance(B);
      const C_ETHBalance_After = await web3.eth.getBalance(C);
      const D_ETHBalance_After = await web3.eth.getBalance(D);

      // Check ETH balances have not changed
      assert.equal(A_ETHBalance_After, A_ETHBalance_Before);
      assert.equal(B_ETHBalance_After, B_ETHBalance_Before);
      assert.equal(C_ETHBalance_After, C_ETHBalance_Before);
      assert.equal(D_ETHBalance_After, D_ETHBalance_Before);
    });

    it("provideToSP(), new deposit after past full withdrawal: depositor does not receive ETH gains", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // Whale transfers USDD to A, B
      await usddToken.transfer(A, dec(1000, 18), { from: whale });
      await usddToken.transfer(B, dec(1000, 18), { from: whale });

      // C, D open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(4000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---
      // A, B, C, D provide to SP
      await stabilityPool.provideToSP(dec(105, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(105, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(105, 18), frontEnd_1, { from: C });
      await stabilityPool.provideToSP(dec(105, 18), ZERO_ADDRESS, { from: D });

      // time passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // B deposits. A,B,C,D earn DEFT
      await stabilityPool.provideToSP(dec(5, 18), ZERO_ADDRESS, { from: B });

      // Price drops, defaulter is liquidated, A, B, C, D earn ETH
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      // Price bounces back
      await priceFeed.setPrice(dec(200, 18));

      // A B,C, D fully withdraw from the pool
      await stabilityPool.withdrawFromSP(dec(105, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(105, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(105, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(105, 18), { from: D });

      // --- TEST ---

      // get current ETH balances
      const A_ETHBalance_Before = await web3.eth.getBalance(A);
      const B_ETHBalance_Before = await web3.eth.getBalance(B);
      const C_ETHBalance_Before = await web3.eth.getBalance(C);
      const D_ETHBalance_Before = await web3.eth.getBalance(D);

      // A, B, C, D provide to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: B, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(300, 18), frontEnd_2, { from: C, gasPrice: 0 });
      await stabilityPool.provideToSP(dec(400, 18), ZERO_ADDRESS, { from: D, gasPrice: 0 });

      // Get  ETH balances after
      const A_ETHBalance_After = await web3.eth.getBalance(A);
      const B_ETHBalance_After = await web3.eth.getBalance(B);
      const C_ETHBalance_After = await web3.eth.getBalance(C);
      const D_ETHBalance_After = await web3.eth.getBalance(D);

      // Check ETH balances have not changed
      assert.equal(A_ETHBalance_After, A_ETHBalance_Before);
      assert.equal(B_ETHBalance_After, B_ETHBalance_Before);
      assert.equal(C_ETHBalance_After, C_ETHBalance_Before);
      assert.equal(D_ETHBalance_After, D_ETHBalance_Before);
    });

    it("provideToSP(), topup: triggers DEFT reward event - increases the sum G", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C provide to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(50, 18), frontEnd_1, { from: B });
      await stabilityPool.provideToSP(dec(50, 18), frontEnd_1, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      const G_Before = await stabilityPool.epochToScaleToG(0, 0);

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // B tops up
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: B });

      const G_After = await stabilityPool.epochToScaleToG(0, 0);

      // Expect G has increased from the DEFT reward event triggered by B's topup
      assert.isTrue(G_After.gt(G_Before));
    });

    it("provideToSP(), topup from different front end: doesn't change the front end tag", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // whale transfer to troves D and E
      await usddToken.transfer(D, dec(100, 18), { from: whale });
      await usddToken.transfer(E, dec(200, 18), { from: whale });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, D, E provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), ZERO_ADDRESS, { from: C });
      await stabilityPool.provideToSP(dec(40, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: E });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A, B, C, D, E top up, from different front ends
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_2, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_1, { from: B });
      await stabilityPool.provideToSP(dec(15, 18), frontEnd_3, { from: C });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: D });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: E });

      const frontEndTag_A = (await stabilityPool.deposits(A))[1];
      const frontEndTag_B = (await stabilityPool.deposits(B))[1];
      const frontEndTag_C = (await stabilityPool.deposits(C))[1];
      const frontEndTag_D = (await stabilityPool.deposits(D))[1];
      const frontEndTag_E = (await stabilityPool.deposits(E))[1];

      // Check deposits are still tagged with their original front end
      assert.equal(frontEndTag_A, frontEnd_1);
      assert.equal(frontEndTag_B, frontEnd_2);
      assert.equal(frontEndTag_C, ZERO_ADDRESS);
      assert.equal(frontEndTag_D, frontEnd_1);
      assert.equal(frontEndTag_E, ZERO_ADDRESS);
    });

    it("provideToSP(), topup: depositor receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), ZERO_ADDRESS, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get A, B, C DEFT balance before
      const A_DEFTBalance_Before = await deftToken.balanceOf(A);
      const B_DEFTBalance_Before = await deftToken.balanceOf(B);
      const C_DEFTBalance_Before = await deftToken.balanceOf(C);

      // A, B, C top up
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), ZERO_ADDRESS, { from: C });

      // Get DEFT balance after
      const A_DEFTBalance_After = await deftToken.balanceOf(A);
      const B_DEFTBalance_After = await deftToken.balanceOf(B);
      const C_DEFTBalance_After = await deftToken.balanceOf(C);

      // Check DEFT Balance of A, B, C has increased
      assert.isTrue(A_DEFTBalance_After.gt(A_DEFTBalance_Before));
      assert.isTrue(B_DEFTBalance_After.gt(B_DEFTBalance_Before));
      assert.isTrue(C_DEFTBalance_After.gt(C_DEFTBalance_Before));
    });

    it("provideToSP(), topup: tagged front end receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get front ends' DEFT balance before
      const F1_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_1);
      const F2_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_2);
      const F3_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_3);

      // A, B, C top up  (front end param passed here is irrelevant)
      await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: A }); // provides no front end param
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_1, { from: B }); // provides front end that doesn't match his tag
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C }); // provides front end that matches his tag

      // Get front ends' DEFT balance after
      const F1_DEFTBalance_After = await deftToken.balanceOf(A);
      const F2_DEFTBalance_After = await deftToken.balanceOf(B);
      const F3_DEFTBalance_After = await deftToken.balanceOf(C);

      // Check DEFT Balance of front ends has increased
      assert.isTrue(F1_DEFTBalance_After.gt(F1_DEFTBalance_Before));
      assert.isTrue(F2_DEFTBalance_After.gt(F2_DEFTBalance_Before));
      assert.isTrue(F3_DEFTBalance_After.gt(F3_DEFTBalance_Before));
    });

    it("provideToSP(), topup: tagged front end's stake increases", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, D, E, F open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(300, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: F }
      });

      // A, B, C, D, E, F provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C });
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: E });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: F });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get front ends' stake before
      const F1_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_3);

      // A, B, C top up  (front end param passed here is irrelevant)
      await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: A }); // provides no front end param
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_1, { from: B }); // provides front end that doesn't match his tag
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C }); // provides front end that matches his tag

      // Get front ends' stakes after
      const F1_Stake_After = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_After = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_After = await stabilityPool.frontEndStakes(frontEnd_3);

      // Check front ends' stakes have increased
      assert.isTrue(F1_Stake_After.gt(F1_Stake_Before));
      assert.isTrue(F2_Stake_After.gt(F2_Stake_Before));
      assert.isTrue(F3_Stake_After.gt(F3_Stake_Before));
    });

    it("provideToSP(), topup: tagged front end's snapshots update", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(200, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(400, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(600, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---

      const deposit_A = dec(100, 18);
      const deposit_B = dec(200, 18);
      const deposit_C = dec(300, 18);

      // A, B, C make their initial deposits
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      // fastforward time then make an SP deposit, to make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      await stabilityPool.provideToSP(await usddToken.balanceOf(D), ZERO_ADDRESS, { from: D });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(100, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // Get front ends' snapshots before
      for (frontEnd of [frontEnd_1, frontEnd_2, frontEnd_3]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends, since S corresponds to ETH gain)
        assert.equal(snapshot[1], dec(1, 18)); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      // --- TEST ---

      // A, B, C top up their deposits. Grab G at each stage, as it can increase a bit
      // between topups, because some block.timestamp time passes (and DEFT is issued) between ops
      const G1 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });

      const G2 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });

      const G3 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3];
      const G_Values = [G1, G2, G3];

      // Map frontEnds to the value of G at time the deposit was made
      frontEndToG = th.zipToObject(frontEnds, G_Values);

      // Get front ends' snapshots after
      for (const [frontEnd, G] of Object.entries(frontEndToG)) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        // Check snapshots are the expected values
        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends)
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].eq(G)); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("provideToSP(): reverts when amount is zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(1000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(2000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      // Whale transfers USDD to C, D
      await usddToken.transfer(C, dec(100, 18), { from: whale });
      await usddToken.transfer(D, dec(100, 18), { from: whale });

      txPromise_A = stabilityPool.provideToSP(0, frontEnd_1, { from: A });
      txPromise_B = stabilityPool.provideToSP(0, ZERO_ADDRESS, { from: B });
      txPromise_C = stabilityPool.provideToSP(0, frontEnd_2, { from: C });
      txPromise_D = stabilityPool.provideToSP(0, ZERO_ADDRESS, { from: D });

      await th.assertRevert(txPromise_A, "StabilityPool: Amount must be non-zero");
      await th.assertRevert(txPromise_B, "StabilityPool: Amount must be non-zero");
      await th.assertRevert(txPromise_C, "StabilityPool: Amount must be non-zero");
      await th.assertRevert(txPromise_D, "StabilityPool: Amount must be non-zero");
    });

    it("provideToSP(): reverts if user is a registered front end", async () => {
      // C, D, E, F open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: F }
      });

      // C, E, F registers as front end
      await stabilityPool.registerFrontEnd(dec(1, 18), { from: C });
      await stabilityPool.registerFrontEnd(dec(1, 18), { from: E });
      await stabilityPool.registerFrontEnd(dec(1, 18), { from: F });

      const txPromise_C = stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: C });
      const txPromise_E = stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: E });
      const txPromise_F = stabilityPool.provideToSP(dec(10, 18), F, { from: F });
      await th.assertRevert(
        txPromise_C,
        "StabilityPool: must not already be a registered front end"
      );
      await th.assertRevert(
        txPromise_E,
        "StabilityPool: must not already be a registered front end"
      );
      await th.assertRevert(
        txPromise_F,
        "StabilityPool: must not already be a registered front end"
      );

      const txD = await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: D });
      assert.isTrue(txD.receipt.status);
    });

    it("provideToSP(): reverts if provided tag is not a registered front end", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const txPromise_C = stabilityPool.provideToSP(dec(10, 18), A, { from: C }); // passes another EOA
      const txPromise_D = stabilityPool.provideToSP(dec(10, 18), troveManager.address, { from: D });
      const txPromise_E = stabilityPool.provideToSP(dec(10, 18), stabilityPool.address, { from: E });
      const txPromise_F = stabilityPool.provideToSP(dec(10, 18), F, { from: F }); // passes itself

      await th.assertRevert(
        txPromise_C,
        "StabilityPool: Tag must be a registered front end, or the zero address"
      );
      await th.assertRevert(
        txPromise_D,
        "StabilityPool: Tag must be a registered front end, or the zero address"
      );
      await th.assertRevert(
        txPromise_E,
        "StabilityPool: Tag must be a registered front end, or the zero address"
      );
      await th.assertRevert(
        txPromise_F,
        "StabilityPool: Tag must be a registered front end, or the zero address"
      );
    });

    // --- withdrawFromSP ---

    it("withdrawFromSP(): reverts when user has no active deposit", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });

      const alice_initialDeposit = (await stabilityPool.deposits(alice))[0].toString();
      const bob_initialDeposit = (await stabilityPool.deposits(bob))[0].toString();

      assert.equal(alice_initialDeposit, dec(100, 18));
      assert.equal(bob_initialDeposit, "0");

      const txAlice = await stabilityPool.withdrawFromSP(dec(100, 18), { from: alice });
      assert.isTrue(txAlice.receipt.status);

      try {
        const txBob = await stabilityPool.withdrawFromSP(dec(100, 18), { from: bob });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
        // TODO: infamous issue #99
        //assert.include(err.message, "User must have a non-zero deposit")
      }
    });

    it("withdrawFromSP(): reverts when amount > 0 and system has an undercollateralized trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });

      const alice_initialDeposit = (await stabilityPool.deposits(alice))[0].toString();
      assert.equal(alice_initialDeposit, dec(100, 18));

      // defaulter opens trove
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // ETH drops, defaulter is in liquidation range (but not liquidated yet)
      await priceFeed.setPrice(dec(100, 18));

      await th.assertRevert(stabilityPool.withdrawFromSP(dec(100, 18), { from: alice }));
    });

    it("withdrawFromSP(): partial retrieval - retrieves correct USDD amount and the entire ETH Gain, and updates deposit", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 24)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // 2 Troves opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // 2 users with Trove with 170 USDD drawn are closed
      const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner }); // 170 USDD closed
      const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner }); // 170 USDD closed

      const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1);
      const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2);

      // Alice USDDLoss is ((15000/200000) * liquidatedDebt), for each liquidation
      const expectedUSDDLoss_A = liquidatedDebt_1
        .mul(toBN(dec(15000, 18)))
        .div(toBN(dec(200000, 18)))
        .add(liquidatedDebt_2.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))));

      const expectedCompoundedUSDDDeposit_A = toBN(dec(15000, 18)).sub(expectedUSDDLoss_A);
      const compoundedUSDDDeposit_A = await stabilityPool.getCompoundedUSDDDeposit(alice);

      assert.isAtMost(
        th.getDifference(expectedCompoundedUSDDDeposit_A, compoundedUSDDDeposit_A),
        100000
      );

      // Alice retrieves part of her entitled USDD: 9000 USDD
      await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice });

      const expectedNewDeposit_A = compoundedUSDDDeposit_A.sub(toBN(dec(9000, 18)));

      // check Alice's deposit has been updated to equal her compounded deposit minus her withdrawal */
      const newDeposit = (await stabilityPool.deposits(alice))[0].toString();
      assert.isAtMost(th.getDifference(newDeposit, expectedNewDeposit_A), 100000);

      // Expect Alice has withdrawn all ETH gain
      const alice_pendingETHGain = await stabilityPool.getDepositorCollGain(alice);
      assert.equal(alice_pendingETHGain, 0);
    });

    it("withdrawFromSP(): partial retrieval - leaves the correct amount of USDD in the Stability Pool", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 24)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // 2 Troves opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });
      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      const SP_USDD_Before = await stabilityPool.getTotalUSDDDeposits();
      assert.equal(SP_USDD_Before, dec(200000, 18));

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // 2 users liquidated
      const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner });
      const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner });

      const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1);
      const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2);

      // Alice retrieves part of her entitled USDD: 9000 USDD
      await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice });

      /* Check SP has reduced from 2 liquidations and Alice's withdrawal
      Expect USDD in SP = (200000 - liquidatedDebt_1 - liquidatedDebt_2 - 9000) */
      const expectedSPUSDD = toBN(dec(200000, 18))
        .sub(toBN(liquidatedDebt_1))
        .sub(toBN(liquidatedDebt_2))
        .sub(toBN(dec(9000, 18)));

      const SP_USDD_After = (await stabilityPool.getTotalUSDDDeposits()).toString();

      th.assertIsApproximatelyEqual(SP_USDD_After, expectedSPUSDD);
    });

    it("withdrawFromSP(): full retrieval - leaves the correct amount of USDD in the Stability Pool", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // 2 Troves opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // --- TEST ---

      // Alice makes deposit #1
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      const SP_USDD_Before = await stabilityPool.getTotalUSDDDeposits();
      assert.equal(SP_USDD_Before, dec(200000, 18));

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // 2 defaulters liquidated
      const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner });
      const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner });

      const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1);
      const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2);

      // Alice USDDLoss is ((15000/200000) * liquidatedDebt), for each liquidation
      const expectedUSDDLoss_A = liquidatedDebt_1
        .mul(toBN(dec(15000, 18)))
        .div(toBN(dec(200000, 18)))
        .add(liquidatedDebt_2.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))));

      const expectedCompoundedUSDDDeposit_A = toBN(dec(15000, 18)).sub(expectedUSDDLoss_A);
      const compoundedUSDDDeposit_A = await stabilityPool.getCompoundedUSDDDeposit(alice);

      assert.isAtMost(
        th.getDifference(expectedCompoundedUSDDDeposit_A, compoundedUSDDDeposit_A),
        100000
      );

      const USDDinSPBefore = await stabilityPool.getTotalUSDDDeposits();

      // Alice retrieves all of her entitled USDD:
      await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice });

      const expectedUSDDinSPAfter = USDDinSPBefore.sub(compoundedUSDDDeposit_A);

      const USDDinSPAfter = await stabilityPool.getTotalUSDDDeposits();
      assert.isAtMost(th.getDifference(expectedUSDDinSPAfter, USDDinSPAfter), 100000);
    });

    it("withdrawFromSP(): Subsequent deposit and withdrawal attempt from same account, with no intermediate liquidations, withdraws zero ETH", async () => {
      // --- SETUP ---
      // Whale deposits 1850 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(18500, 18), frontEnd_1, { from: whale });

      // 2 defaulters open
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // defaulters liquidated
      await troveManager.liquidate(defaulter_1, { from: owner });
      await troveManager.liquidate(defaulter_2, { from: owner });

      // Alice retrieves all of her entitled USDD:
      await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice });
      assert.equal(await stabilityPool.getDepositorCollGain(alice), 0);

      // Alice makes second deposit
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      assert.equal(await stabilityPool.getDepositorCollGain(alice), 0);

      const ETHinSP_Before = (await stabilityPool.getColl()).toString();

      // Alice attempts second withdrawal
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice });
      assert.equal(await stabilityPool.getDepositorCollGain(alice), 0);

      // Check ETH in pool does not change
      const ETHinSP_1 = (await stabilityPool.getColl()).toString();
      assert.equal(ETHinSP_Before, ETHinSP_1);

      // Third deposit
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      assert.equal(await stabilityPool.getDepositorCollGain(alice), 0);

      // Alice attempts third withdrawal (this time, frm SP to Trove)
      const txPromise_A = stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      await th.assertRevert(txPromise_A);
    });

    it("withdrawFromSP(): it correctly updates the user's USDD and ETH snapshots of entitled reward per unit staked", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // 2 defaulters open
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // check 'Before' snapshots
      const alice_snapshot_Before = await stabilityPool.depositSnapshots(alice);
      const alice_snapshot_S_Before = alice_snapshot_Before[0].toString();
      const alice_snapshot_P_Before = alice_snapshot_Before[1].toString();
      assert.equal(alice_snapshot_S_Before, 0);
      assert.equal(alice_snapshot_P_Before, "1000000000000000000");

      // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // 2 defaulters liquidated
      await troveManager.liquidate(defaulter_1, { from: owner });
      await troveManager.liquidate(defaulter_2, { from: owner });

      // Alice retrieves part of her entitled USDD: 9000 USDD
      await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice });

      const P = (await stabilityPool.P()).toString();
      const S = (await stabilityPool.epochToScaleToSum(0, 0)).toString();
      // check 'After' snapshots
      const alice_snapshot_After = await stabilityPool.depositSnapshots(alice);
      const alice_snapshot_S_After = alice_snapshot_After[0].toString();
      const alice_snapshot_P_After = alice_snapshot_After[1].toString();
      assert.equal(alice_snapshot_S_After, S);
      assert.equal(alice_snapshot_P_After, P);
    });

    it("withdrawFromSP(): decreases StabilityPool ETH", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // 1 defaulter opens
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // price drops: defaulter's Trove falls below MCR, alice and whale Trove remain active
      await priceFeed.setPrice("100000000000000000000");

      // defaulter's Trove is closed.
      const liquidationTx_1 = await troveManager.liquidate(defaulter_1, { from: owner }); // 180 USDD closed
      const [, liquidatedColl] = th.getEmittedLiquidationValues(liquidationTx_1);

      //Get ActivePool and StabilityPool Ether before retrieval:
      const active_ETH_Before = await activePool.getColl(collToken.address);
      const stability_ETH_Before = await stabilityPool.getColl();

      // Expect alice to be entitled to 15000/200000 of the liquidated coll
      const aliceExpectedETHGain = liquidatedColl
        .mul(toBN(dec(15000, 18)))
        .div(toBN(dec(200000, 18)));
      const aliceETHGain = await stabilityPool.getDepositorCollGain(alice);
      assert.isTrue(aliceExpectedETHGain.eq(aliceETHGain));

      // Alice retrieves all of her deposit
      await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice });

      const active_ETH_After = await activePool.getColl(collToken.address);
      const stability_ETH_After = await stabilityPool.getColl();

      const active_ETH_Difference = active_ETH_Before.sub(active_ETH_After);
      const stability_ETH_Difference = stability_ETH_Before.sub(stability_ETH_After);

      assert.equal(active_ETH_Difference, "0");

      // Expect StabilityPool to have decreased by Alice's ETHGain
      assert.isAtMost(th.getDifference(stability_ETH_Difference, aliceETHGain), 10000);
    });

    it("withdrawFromSP(): All depositors are able to withdraw from the SP to their account", async () => {
      // Whale opens trove
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });

      // 1 defaulter open
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // 6 Accounts open troves and provide to SP
      const depositors = [alice, bob, carol, dennis, erin, flyn];
      for (account of depositors) {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: account }
        });
        await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: account });
      }

      await priceFeed.setPrice(dec(105, 18));
      await troveManager.liquidate(defaulter_1);

      await priceFeed.setPrice(dec(200, 18));

      // All depositors attempt to withdraw
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: erin });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: flyn });
      assert.equal((await stabilityPool.deposits(alice))[0].toString(), "0");

      const totalDeposits = (await stabilityPool.getTotalUSDDDeposits()).toString();

      assert.isAtMost(th.getDifference(totalDeposits, "0"), 100000);
    });

    it("withdrawFromSP(): increases depositor's USDD token balance by the expected amount", async () => {
      // Whale opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // 1 defaulter opens trove
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: {
          from: defaulter_1,
          value: toBN(dec(100, "ether"))
        }
      });

      const defaulterDebt = (await troveManager.getEntireDebtAndColl(defaulter_1))[0];

      // 6 Accounts open troves and provide to SP
      const depositors = [alice, bob, carol, dennis, erin, flyn];
      for (account of depositors) {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: account }
        });
        await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: account });
      }

      await priceFeed.setPrice(dec(105, 18));
      await troveManager.liquidate(defaulter_1);

      const aliceBalBefore = await usddToken.balanceOf(alice);
      const bobBalBefore = await usddToken.balanceOf(bob);

      /* From an offset of 10000 USDD, each depositor receives
      USDDLoss = 1666.6666666666666666 USDD

      and thus with a deposit of 10000 USDD, each should withdraw 8333.3333333333333333 USDD (in practice, slightly less due to rounding error)
      */

      // Price bounces back to $200 per ETH
      await priceFeed.setPrice(dec(200, 18));

      // Bob issues a further 5000 USDD from his trove
      await borrowerOperations.withdrawUSDD(th._100pct, dec(5000, 18), bob, bob, { from: bob });

      // Expect Alice's USDD balance increase be very close to 8333.3333333333333333 USDD
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice });
      const aliceBalance = await usddToken.balanceOf(alice);

      assert.isAtMost(
        th.getDifference(aliceBalance.sub(aliceBalBefore), "8333333333333333333333"),
        100000
      );

      // expect Bob's USDD balance increase to be very close to  13333.33333333333333333 USDD
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob });
      const bobBalance = await usddToken.balanceOf(bob);
      assert.isAtMost(
        th.getDifference(bobBalance.sub(bobBalBefore), "13333333333333333333333"),
        100000
      );
    });

    it("withdrawFromSP(): doesn't impact other users Stability deposits or ETH gains", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_1, { from: carol });

      // Would-be defaulters open troves
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      // Defaulters are liquidated
      await troveManager.liquidate(defaulter_1);
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      const alice_USDDDeposit_Before = (
        await stabilityPool.getCompoundedUSDDDeposit(alice)
      ).toString();
      const bob_USDDDeposit_Before = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();

      const alice_ETHGain_Before = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_Before = (await stabilityPool.getDepositorCollGain(bob)).toString();

      //check non-zero USDD and ETHGain in the Stability Pool
      const USDDinSP = await stabilityPool.getTotalUSDDDeposits();
      const ETHinSP = await stabilityPool.getColl();
      assert.isTrue(USDDinSP.gt(mv._zeroBN));
      assert.isTrue(ETHinSP.gt(mv._zeroBN));

      // Price rises
      await priceFeed.setPrice(dec(200, 18));

      // Carol withdraws her Stability deposit
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), dec(30000, 18));
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol });
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), "0");

      const alice_USDDDeposit_After = (
        await stabilityPool.getCompoundedUSDDDeposit(alice)
      ).toString();
      const bob_USDDDeposit_After = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();

      const alice_ETHGain_After = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_After = (await stabilityPool.getDepositorCollGain(bob)).toString();

      // Check compounded deposits and ETH gains for A and B have not changed
      assert.equal(alice_USDDDeposit_Before, alice_USDDDeposit_After);
      assert.equal(bob_USDDDeposit_Before, bob_USDDDeposit_After);

      assert.equal(alice_ETHGain_Before, alice_ETHGain_After);
      assert.equal(bob_ETHGain_Before, bob_ETHGain_After);
    });

    it("withdrawFromSP(): doesn't impact system debt, collateral or TCR ", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_1, { from: carol });

      // Would-be defaulters open troves
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      // Defaulters are liquidated
      await troveManager.liquidate(defaulter_1);
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      // Price rises
      await priceFeed.setPrice(dec(200, 18));

      const activeDebt_Before = (await activePool.getUSDDDebt()).toString();
      const defaultedDebt_Before = (await defaultPool.getUSDDDebt()).toString();
      const activeColl_Before = (await activePool.getColl(collToken.address)).toString();
      const defaultedColl_Before = (await defaultPool.getColl(collToken.address)).toString();
      const TCR_Before = (await th.getTCR(contracts)).toString();

      // Carol withdraws her Stability deposit
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), dec(30000, 18));
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol });
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), "0");

      const activeDebt_After = (await activePool.getUSDDDebt()).toString();
      const defaultedDebt_After = (await defaultPool.getUSDDDebt()).toString();
      const activeColl_After = (await activePool.getColl(collToken.address)).toString();
      const defaultedColl_After = (await defaultPool.getColl(collToken.address)).toString();
      const TCR_After = (await th.getTCR(contracts)).toString();

      // Check total system debt, collateral and TCR have not changed after a Stability deposit is made
      assert.equal(activeDebt_Before, activeDebt_After);
      assert.equal(defaultedDebt_Before, defaultedDebt_After);
      assert.equal(activeColl_Before, activeColl_After);
      assert.equal(defaultedColl_Before, defaultedColl_After);
      assert.equal(TCR_Before, TCR_After);
    });

    it("withdrawFromSP(): doesn't impact any troves, including the caller's trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A, B and C provide to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_1, { from: carol });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();

      // Get debt, collateral and ICR of all existing troves
      const whale_Debt_Before = (await troveManager.Troves(whale))[0].toString();
      const alice_Debt_Before = (await troveManager.Troves(alice))[0].toString();
      const bob_Debt_Before = (await troveManager.Troves(bob))[0].toString();
      const carol_Debt_Before = (await troveManager.Troves(carol))[0].toString();

      const whale_Coll_Before = (await troveManager.Troves(whale))[1].toString();
      const alice_Coll_Before = (await troveManager.Troves(alice))[1].toString();
      const bob_Coll_Before = (await troveManager.Troves(bob))[1].toString();
      const carol_Coll_Before = (await troveManager.Troves(carol))[1].toString();

      const whale_ICR_Before = (await troveManager.getCurrentICR(whale, price)).toString();
      const alice_ICR_Before = (await troveManager.getCurrentICR(alice, price)).toString();
      const bob_ICR_Before = (await troveManager.getCurrentICR(bob, price)).toString();
      const carol_ICR_Before = (await troveManager.getCurrentICR(carol, price)).toString();

      // price rises
      await priceFeed.setPrice(dec(200, 18));

      // Carol withdraws her Stability deposit
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), dec(30000, 18));
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol });
      assert.equal((await stabilityPool.deposits(carol))[0].toString(), "0");

      const whale_Debt_After = (await troveManager.Troves(whale))[0].toString();
      const alice_Debt_After = (await troveManager.Troves(alice))[0].toString();
      const bob_Debt_After = (await troveManager.Troves(bob))[0].toString();
      const carol_Debt_After = (await troveManager.Troves(carol))[0].toString();

      const whale_Coll_After = (await troveManager.Troves(whale))[1].toString();
      const alice_Coll_After = (await troveManager.Troves(alice))[1].toString();
      const bob_Coll_After = (await troveManager.Troves(bob))[1].toString();
      const carol_Coll_After = (await troveManager.Troves(carol))[1].toString();

      const whale_ICR_After = (await troveManager.getCurrentICR(whale, price)).toString();
      const alice_ICR_After = (await troveManager.getCurrentICR(alice, price)).toString();
      const bob_ICR_After = (await troveManager.getCurrentICR(bob, price)).toString();
      const carol_ICR_After = (await troveManager.getCurrentICR(carol, price)).toString();

      // Check all troves are unaffected by Carol's Stability deposit withdrawal
      assert.equal(whale_Debt_Before, whale_Debt_After);
      assert.equal(alice_Debt_Before, alice_Debt_After);
      assert.equal(bob_Debt_Before, bob_Debt_After);
      assert.equal(carol_Debt_Before, carol_Debt_After);

      assert.equal(whale_Coll_Before, whale_Coll_After);
      assert.equal(alice_Coll_Before, alice_Coll_After);
      assert.equal(bob_Coll_Before, bob_Coll_After);
      assert.equal(carol_Coll_Before, carol_Coll_After);

      assert.equal(whale_ICR_Before, whale_ICR_After);
      assert.equal(alice_ICR_Before, alice_ICR_After);
      assert.equal(bob_ICR_Before, bob_ICR_After);
      assert.equal(carol_ICR_Before, carol_ICR_After);
    });

    it("withdrawFromSP(): succeeds when amount is 0 and system has an undercollateralized trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });

      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A });

      const A_initialDeposit = (await stabilityPool.deposits(A))[0].toString();
      assert.equal(A_initialDeposit, dec(100, 18));

      // defaulters opens trove
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });

      // ETH drops, defaulters are in liquidation range
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();
      assert.isTrue(await th.ICRbetween100and110(defaulter_1, troveManager, price));

      await th.fastForwardTime(timeValues.MINUTES_IN_ONE_WEEK, web3.currentProvider);

      // Liquidate d1
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      // Check d2 is undercollateralized
      assert.isTrue(await th.ICRbetween100and110(defaulter_2, troveManager, price));
      assert.isTrue(await sortedTroves.contains(defaulter_2));

      const A_ETHBalBefore = toBN(await web3.eth.getBalance(A));
      const A_DEFTBalBefore = await deftToken.balanceOf(A);

      // Check Alice has gains to withdraw
      const A_pendingETHGain = await stabilityPool.getDepositorCollGain(A);
      const A_pendingDEFTGain = await stabilityPool.getDepositorDEFTGain(A);
      assert.isTrue(A_pendingETHGain.gt(toBN("0")));
      assert.isTrue(A_pendingDEFTGain.gt(toBN("0")));

      const A_CollTokenBalBefore = await collToken.balanceOf(A);

      // Check withdrawal of 0 succeeds
      const tx = await stabilityPool.withdrawFromSP(0, { from: A, gasPrice: 0 });
      assert.isTrue(tx.receipt.status);
      const A_CollTokenBalAfter = await collToken.balanceOf(A);

      const A_ETHBalAfter = toBN(await web3.eth.getBalance(A));

      const A_DEFTBalAfter = await deftToken.balanceOf(A);
      const A_DEFTBalDiff = A_DEFTBalAfter.sub(A_DEFTBalBefore);

      // Check A's ETH and DEFT balances have increased correctly
      assert.isTrue(A_ETHBalAfter.eq(A_ETHBalBefore));
      assert.isTrue(A_CollTokenBalAfter.sub(A_CollTokenBalBefore).eq(A_pendingETHGain));
      assert.isAtMost(th.getDifference(A_DEFTBalDiff, A_pendingDEFTGain), 1000);
    });

    it("withdrawFromSP(): withdrawing 0 USDD doesn't alter the caller's deposit or the total USDD in the Stability Pool", async () => {
      // --- SETUP ---
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A, B, C provides 100, 50, 30 USDD to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(50, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_1, { from: carol });

      const bob_Deposit_Before = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();
      const USDDinSP_Before = (await stabilityPool.getTotalUSDDDeposits()).toString();

      assert.equal(USDDinSP_Before, dec(180, 18));

      // Bob withdraws 0 USDD from the Stability Pool
      await stabilityPool.withdrawFromSP(0, { from: bob });

      // check Bob's deposit and total USDD in Stability Pool has not changed
      const bob_Deposit_After = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();
      const USDDinSP_After = (await stabilityPool.getTotalUSDDDeposits()).toString();

      assert.equal(bob_Deposit_Before, bob_Deposit_After);
      assert.equal(USDDinSP_Before, USDDinSP_After);
    });

    it("withdrawFromSP(): withdrawing 0 ETH Gain does not alter the caller's ETH balance, their trove collateral, or the ETH  in the Stability Pool", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // Would-be defaulter open trove
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Defaulter 1 liquidated, full offset
      await troveManager.liquidate(defaulter_1);

      // Dennis opens trove and deposits to Stability Pool
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: dennis });

      // Check Dennis has 0 ETHGain
      const dennis_ETHGain = (await stabilityPool.getDepositorCollGain(dennis)).toString();
      assert.equal(dennis_ETHGain, "0");

      const dennis_ETHBalance_Before = web3.eth.getBalance(dennis).toString();
      const dennis_Collateral_Before = (await troveManager.Troves(dennis))[1].toString();
      const ETHinSP_Before = (await stabilityPool.getColl()).toString();

      await priceFeed.setPrice(dec(200, 18));

      // Dennis withdraws his full deposit and ETHGain to his account
      await stabilityPool.withdrawFromSP(dec(100, 18), { from: dennis, gasPrice: 0 });

      // Check withdrawal does not alter Dennis' ETH balance or his trove's collateral
      const dennis_ETHBalance_After = web3.eth.getBalance(dennis).toString();
      const dennis_Collateral_After = (await troveManager.Troves(dennis))[1].toString();
      const ETHinSP_After = (await stabilityPool.getColl()).toString();

      assert.equal(dennis_ETHBalance_Before, dennis_ETHBalance_After);
      assert.equal(dennis_Collateral_Before, dennis_Collateral_After);

      // Check withdrawal has not altered the ETH in the Stability Pool
      assert.equal(ETHinSP_Before, ETHinSP_After);
    });

    it("withdrawFromSP(): Request to withdraw > caller's deposit only withdraws the caller's compounded deposit", async () => {
      // --- SETUP ---
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });

      // A, B, C provide USDD to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_1, { from: carol });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));

      // Liquidate defaulter 1
      await troveManager.liquidate(defaulter_1);

      const alice_USDD_Balance_Before = await usddToken.balanceOf(alice);
      const bob_USDD_Balance_Before = await usddToken.balanceOf(bob);

      const alice_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(alice);
      const bob_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(bob);

      const USDDinSP_Before = await stabilityPool.getTotalUSDDDeposits();

      await priceFeed.setPrice(dec(200, 18));

      // Bob attempts to withdraws 1 wei more than his compounded deposit from the Stability Pool
      await stabilityPool.withdrawFromSP(bob_Deposit_Before.add(toBN(1)), { from: bob });

      // Check Bob's USDD balance has risen by only the value of his compounded deposit
      const bob_expectedUSDDBalance = bob_USDD_Balance_Before.add(bob_Deposit_Before).toString();
      const bob_USDD_Balance_After = (await usddToken.balanceOf(bob)).toString();
      assert.equal(bob_USDD_Balance_After, bob_expectedUSDDBalance);

      // Alice attempts to withdraws 2309842309.000000000000000000 USDD from the Stability Pool
      await stabilityPool.withdrawFromSP("2309842309000000000000000000", { from: alice });

      // Check Alice's USDD balance has risen by only the value of her compounded deposit
      const alice_expectedUSDDBalance = alice_USDD_Balance_Before
        .add(alice_Deposit_Before)
        .toString();
      const alice_USDD_Balance_After = (await usddToken.balanceOf(alice)).toString();
      assert.equal(alice_USDD_Balance_After, alice_expectedUSDDBalance);

      // Check USDD in Stability Pool has been reduced by only Alice's compounded deposit and Bob's compounded deposit
      const expectedUSDDinSP = USDDinSP_Before.sub(alice_Deposit_Before)
        .sub(bob_Deposit_Before)
        .toString();
      const USDDinSP_After = (await stabilityPool.getTotalUSDDDeposits()).toString();
      assert.equal(USDDinSP_After, expectedUSDDinSP);
    });

    it("withdrawFromSP(): Request to withdraw 2^256-1 USDD only withdraws the caller's compounded deposit", async () => {
      // --- SETUP ---
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      // A, B, C open troves
      // A, B, C open troves
      // A, B, C open troves
      // A, B, C open troves
      // A, B, C open troves
      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // A, B, C provides 100, 50, 30 USDD to SP
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(50, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_1, { from: carol });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));

      // Liquidate defaulter 1
      await troveManager.liquidate(defaulter_1);

      const bob_USDD_Balance_Before = await usddToken.balanceOf(bob);

      const bob_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(bob);

      const USDDinSP_Before = await stabilityPool.getTotalUSDDDeposits();

      const maxBytes32 = web3.utils.toBN(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      );

      // Price drops
      await priceFeed.setPrice(dec(200, 18));

      // Bob attempts to withdraws maxBytes32 USDD from the Stability Pool
      await stabilityPool.withdrawFromSP(maxBytes32, { from: bob });

      // Check Bob's USDD balance has risen by only the value of his compounded deposit
      const bob_expectedUSDDBalance = bob_USDD_Balance_Before.add(bob_Deposit_Before).toString();
      const bob_USDD_Balance_After = (await usddToken.balanceOf(bob)).toString();
      assert.equal(bob_USDD_Balance_After, bob_expectedUSDDBalance);

      // Check USDD in Stability Pool has been reduced by only  Bob's compounded deposit
      const expectedUSDDinSP = USDDinSP_Before.sub(bob_Deposit_Before).toString();
      const USDDinSP_After = (await stabilityPool.getTotalUSDDDeposits()).toString();
      assert.equal(USDDinSP_After, expectedUSDDinSP);
    });

    it("withdrawFromSP(): caller can withdraw full deposit and ETH gain during Recovery Mode", async () => {
      // --- SETUP ---

      // Price doubles
      await priceFeed.setPrice(dec(400, 18));
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale }
      });
      // Price halves
      await priceFeed.setPrice(dec(200, 18));

      // A, B, C open troves and make Stability Pool deposits
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(4, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(4, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(4, 18)),
        extraParams: { from: carol }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        extraUSDDAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: {
          from: defaulter_1,
          value: toBN(dec(100, "ether"))
        }
      });
      // A, B, C provides 10000, 5000, 3000 USDD to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(5000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_1, { from: carol });

      // Price drops
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Liquidate defaulter 1
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      const alice_USDD_Balance_Before = await usddToken.balanceOf(alice);
      const bob_USDD_Balance_Before = await usddToken.balanceOf(bob);
      const carol_USDD_Balance_Before = await usddToken.balanceOf(carol);

      const alice_ETH_Balance_Before = web3.utils.toBN(await web3.eth.getBalance(alice));
      const bob_ETH_Balance_Before = web3.utils.toBN(await web3.eth.getBalance(bob));
      const carol_ETH_Balance_Before = web3.utils.toBN(await web3.eth.getBalance(carol));

      const alice_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(alice);
      const bob_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(bob);
      const carol_Deposit_Before = await stabilityPool.getCompoundedUSDDDeposit(carol);

      const alice_ETHGain_Before = await stabilityPool.getDepositorCollGain(alice);
      const bob_ETHGain_Before = await stabilityPool.getDepositorCollGain(bob);
      const carol_ETHGain_Before = await stabilityPool.getDepositorCollGain(carol);

      const USDDinSP_Before = await stabilityPool.getTotalUSDDDeposits();

      // Price rises
      await priceFeed.setPrice(dec(220, 18));

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // A, B, C withdraw their full deposits from the Stability Pool
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice, gasPrice: 0 });
      await stabilityPool.withdrawFromSP(dec(5000, 18), { from: bob, gasPrice: 0 });
      await stabilityPool.withdrawFromSP(dec(3000, 18), { from: carol, gasPrice: 0 });

      // Check USDD balances of A, B, C have risen by the value of their compounded deposits, respectively
      const alice_expectedUSDDBalance = alice_USDD_Balance_Before
        .add(alice_Deposit_Before)
        .toString();

      const bob_expectedUSDDBalance = bob_USDD_Balance_Before.add(bob_Deposit_Before).toString();
      const carol_expectedUSDDBalance = carol_USDD_Balance_Before
        .add(carol_Deposit_Before)
        .toString();

      const alice_USDD_Balance_After = (await usddToken.balanceOf(alice)).toString();

      const bob_USDD_Balance_After = (await usddToken.balanceOf(bob)).toString();
      const carol_USDD_Balance_After = (await usddToken.balanceOf(carol)).toString();

      assert.equal(alice_USDD_Balance_After, alice_expectedUSDDBalance);
      assert.equal(bob_USDD_Balance_After, bob_expectedUSDDBalance);
      assert.equal(carol_USDD_Balance_After, carol_expectedUSDDBalance);

      // Check ETH balances of A, B, C have increased by the value of their ETH gain from liquidations, respectively
      const alice_expectedETHBalance = alice_ETH_Balance_Before.add(alice_ETHGain_Before).toString();
      const bob_expectedETHBalance = bob_ETH_Balance_Before.add(bob_ETHGain_Before).toString();
      const carol_expectedETHBalance = carol_ETH_Balance_Before.add(carol_ETHGain_Before).toString();

      const alice_ETHBalance_After = (await web3.eth.getBalance(alice)).toString();
      const bob_ETHBalance_After = (await web3.eth.getBalance(bob)).toString();
      const carol_ETHBalance_After = (await web3.eth.getBalance(carol)).toString();

      assert.equal(alice_expectedETHBalance, alice_ETHBalance_After);
      assert.equal(bob_expectedETHBalance, bob_ETHBalance_After);
      assert.equal(carol_expectedETHBalance, carol_ETHBalance_After);

      // Check USDD in Stability Pool has been reduced by A, B and C's compounded deposit
      const expectedUSDDinSP = USDDinSP_Before.sub(alice_Deposit_Before)
        .sub(bob_Deposit_Before)
        .sub(carol_Deposit_Before)
        .toString();
      const USDDinSP_After = (await stabilityPool.getTotalUSDDDeposits()).toString();
      assert.equal(USDDinSP_After, expectedUSDDinSP);

      // Check ETH in SP has reduced to zero
      const ETHinSP_After = (await stabilityPool.getColl()).toString();
      assert.isAtMost(th.getDifference(ETHinSP_After, "0"), 100000);
    });

    it("getDepositorCollGain(): depositor does not earn further ETH gains from liquidations while their compounded deposit == 0: ", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 24)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // defaulters open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: defaulter_1 }
      });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_3 } });

      // A, B, provide 10000, 5000 USDD to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(5000, 18), frontEnd_1, { from: bob });

      //price drops
      await priceFeed.setPrice(dec(105, 18));

      // Liquidate defaulter 1. Empties the Pool
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      const USDDinSP = (await stabilityPool.getTotalUSDDDeposits()).toString();
      assert.equal(USDDinSP, "0");

      // Check Stability deposits have been fully cancelled with debt, and are now all zero
      const alice_Deposit = (await stabilityPool.getCompoundedUSDDDeposit(alice)).toString();
      const bob_Deposit = (await stabilityPool.getCompoundedUSDDDeposit(bob)).toString();

      assert.equal(alice_Deposit, "0");
      assert.equal(bob_Deposit, "0");

      // Get ETH gain for A and B
      const alice_ETHGain_1 = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_1 = (await stabilityPool.getDepositorCollGain(bob)).toString();

      // Whale deposits 10000 USDD to Stability Pool
      await stabilityPool.provideToSP(dec(1, 24), frontEnd_1, { from: whale });

      // Liquidation 2
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      // Check Alice and Bob have not received ETH gain from liquidation 2 while their deposit was 0
      const alice_ETHGain_2 = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_2 = (await stabilityPool.getDepositorCollGain(bob)).toString();

      assert.equal(alice_ETHGain_1, alice_ETHGain_2);
      assert.equal(bob_ETHGain_1, bob_ETHGain_2);

      // Liquidation 3
      await troveManager.liquidate(defaulter_3);
      assert.isFalse(await sortedTroves.contains(defaulter_3));

      // Check Alice and Bob have not received ETH gain from liquidation 3 while their deposit was 0
      const alice_ETHGain_3 = (await stabilityPool.getDepositorCollGain(alice)).toString();
      const bob_ETHGain_3 = (await stabilityPool.getDepositorCollGain(bob)).toString();

      assert.equal(alice_ETHGain_1, alice_ETHGain_3);
      assert.equal(bob_ETHGain_1, bob_ETHGain_3);
    });

    // --- DEFT functionality ---
    it("withdrawFromSP(): triggers DEFT reward event - increases the sum G", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 24)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A and B provide to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: B });

      const G_Before = await stabilityPool.epochToScaleToG(0, 0);

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A withdraws from SP
      await stabilityPool.withdrawFromSP(dec(5000, 18), { from: A });

      const G_1 = await stabilityPool.epochToScaleToG(0, 0);

      // Expect G has increased from the DEFT reward event triggered
      assert.isTrue(G_1.gt(G_Before));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A withdraws from SP
      await stabilityPool.withdrawFromSP(dec(5000, 18), { from: B });

      const G_2 = await stabilityPool.epochToScaleToG(0, 0);

      // Expect G has increased from the DEFT reward event triggered
      assert.isTrue(G_2.gt(G_1));
    });

    it("withdrawFromSP(), partial withdrawal: doesn't change the front end tag", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // whale transfer to troves D and E
      await usddToken.transfer(D, dec(100, 18), { from: whale });
      await usddToken.transfer(E, dec(200, 18), { from: whale });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, D, E provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), ZERO_ADDRESS, { from: C });
      await stabilityPool.provideToSP(dec(40, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: E });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // A, B, C, D, E withdraw, from different front ends
      await stabilityPool.withdrawFromSP(dec(5, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(10, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(15, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(20, 18), { from: D });
      await stabilityPool.withdrawFromSP(dec(25, 18), { from: E });

      const frontEndTag_A = (await stabilityPool.deposits(A))[1];
      const frontEndTag_B = (await stabilityPool.deposits(B))[1];
      const frontEndTag_C = (await stabilityPool.deposits(C))[1];
      const frontEndTag_D = (await stabilityPool.deposits(D))[1];
      const frontEndTag_E = (await stabilityPool.deposits(E))[1];

      // Check deposits are still tagged with their original front end
      assert.equal(frontEndTag_A, frontEnd_1);
      assert.equal(frontEndTag_B, frontEnd_2);
      assert.equal(frontEndTag_C, ZERO_ADDRESS);
      assert.equal(frontEndTag_D, frontEnd_1);
      assert.equal(frontEndTag_E, ZERO_ADDRESS);
    });

    it("withdrawFromSP(), partial withdrawal: depositor receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), ZERO_ADDRESS, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get A, B, C DEFT balance before
      const A_DEFTBalance_Before = await deftToken.balanceOf(A);
      const B_DEFTBalance_Before = await deftToken.balanceOf(B);
      const C_DEFTBalance_Before = await deftToken.balanceOf(C);

      // A, B, C withdraw
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(2, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(3, 18), { from: C });

      // Get DEFT balance after
      const A_DEFTBalance_After = await deftToken.balanceOf(A);
      const B_DEFTBalance_After = await deftToken.balanceOf(B);
      const C_DEFTBalance_After = await deftToken.balanceOf(C);

      // Check DEFT Balance of A, B, C has increased
      assert.isTrue(A_DEFTBalance_After.gt(A_DEFTBalance_Before));
      assert.isTrue(B_DEFTBalance_After.gt(B_DEFTBalance_Before));
      assert.isTrue(C_DEFTBalance_After.gt(C_DEFTBalance_Before));
    });

    it("withdrawFromSP(), partial withdrawal: tagged front end receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get front ends' DEFT balance before
      const F1_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_1);
      const F2_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_2);
      const F3_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_3);

      // A, B, C withdraw
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(2, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(3, 18), { from: C });

      // Get front ends' DEFT balance after
      const F1_DEFTBalance_After = await deftToken.balanceOf(A);
      const F2_DEFTBalance_After = await deftToken.balanceOf(B);
      const F3_DEFTBalance_After = await deftToken.balanceOf(C);

      // Check DEFT Balance of front ends has increased
      assert.isTrue(F1_DEFTBalance_After.gt(F1_DEFTBalance_Before));
      assert.isTrue(F2_DEFTBalance_After.gt(F2_DEFTBalance_Before));
      assert.isTrue(F3_DEFTBalance_After.gt(F3_DEFTBalance_Before));
    });

    it("withdrawFromSP(), partial withdrawal: tagged front end's stake decreases", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, D, E, F open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: F }
      });

      // A, B, C, D, E, F provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: C });
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(20, 18), frontEnd_2, { from: E });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_3, { from: F });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get front ends' stake before
      const F1_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_3);

      // A, B, C withdraw
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(2, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(3, 18), { from: C });

      // Get front ends' stakes after
      const F1_Stake_After = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_After = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_After = await stabilityPool.frontEndStakes(frontEnd_3);

      // Check front ends' stakes have decreased
      assert.isTrue(F1_Stake_After.lt(F1_Stake_Before));
      assert.isTrue(F2_Stake_After.lt(F2_Stake_Before));
      assert.isTrue(F3_Stake_After.lt(F3_Stake_Before));
    });

    it("withdrawFromSP(), partial withdrawal: tagged front end's snapshots update", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(60000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---

      const deposit_A = dec(10000, 18);
      const deposit_B = dec(20000, 18);
      const deposit_C = dec(30000, 18);

      // A, B, C make their initial deposits
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      // fastforward time then make an SP deposit, to make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      await stabilityPool.provideToSP(dec(1000, 18), ZERO_ADDRESS, { from: D });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // Get front ends' snapshots before
      for (frontEnd of [frontEnd_1, frontEnd_2, frontEnd_3]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends, since S corresponds to ETH gain)
        assert.equal(snapshot[1], dec(1, 18)); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      // --- TEST ---

      await priceFeed.setPrice(dec(200, 18));

      // A, B, C top withdraw part of their deposits. Grab G at each stage, as it can increase a bit
      // between topups, because some block.timestamp time passes (and DEFT is issued) between ops
      const G1 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: A });

      const G2 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawFromSP(dec(2, 18), { from: B });

      const G3 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawFromSP(dec(3, 18), { from: C });

      const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3];
      const G_Values = [G1, G2, G3];

      // Map frontEnds to the value of G at time the deposit was made
      frontEndToG = th.zipToObject(frontEnds, G_Values);

      // Get front ends' snapshots after
      for (const [frontEnd, G] of Object.entries(frontEndToG)) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        // Check snapshots are the expected values
        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends)
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].eq(G)); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("withdrawFromSP(), full withdrawal: removes deposit's front end tag", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // Whale transfers to A, B
      await usddToken.transfer(A, dec(10000, 18), { from: whale });
      await usddToken.transfer(B, dec(20000, 18), { from: whale });

      //C, D open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // A, B, C, D make their initial deposits
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_2, { from: C });
      await stabilityPool.provideToSP(dec(40000, 18), ZERO_ADDRESS, { from: D });

      // Check deposits are tagged with correct front end
      const A_tagBefore = await getFrontEndTag(stabilityPool, A);
      const B_tagBefore = await getFrontEndTag(stabilityPool, B);
      const C_tagBefore = await getFrontEndTag(stabilityPool, C);
      const D_tagBefore = await getFrontEndTag(stabilityPool, D);

      assert.equal(A_tagBefore, frontEnd_1);
      assert.equal(B_tagBefore, ZERO_ADDRESS);
      assert.equal(C_tagBefore, frontEnd_2);
      assert.equal(D_tagBefore, ZERO_ADDRESS);

      // All depositors make full withdrawal
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(20000, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(40000, 18), { from: D });

      // Check all deposits now have no front end tag
      const A_tagAfter = await getFrontEndTag(stabilityPool, A);
      const B_tagAfter = await getFrontEndTag(stabilityPool, B);
      const C_tagAfter = await getFrontEndTag(stabilityPool, C);
      const D_tagAfter = await getFrontEndTag(stabilityPool, D);

      assert.equal(A_tagAfter, ZERO_ADDRESS);
      assert.equal(B_tagAfter, ZERO_ADDRESS);
      assert.equal(C_tagAfter, ZERO_ADDRESS);
      assert.equal(D_tagAfter, ZERO_ADDRESS);
    });

    it("withdrawFromSP(), full withdrawal: zero's depositor's snapshots", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      //  SETUP: Execute a series of operations to make G, S > 0 and P < 1

      // E opens trove and makes a deposit
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: E }
      });
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_3, { from: E });

      // Fast-forward time and make a second deposit, to trigger DEFT reward and make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_3, { from: E });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // --- TEST ---

      // Whale transfers to A, B
      await usddToken.transfer(A, dec(10000, 18), { from: whale });
      await usddToken.transfer(B, dec(20000, 18), { from: whale });

      await priceFeed.setPrice(dec(200, 18));

      // C, D open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: D }
      });

      // A, B, C, D make their initial deposits
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_2, { from: C });
      await stabilityPool.provideToSP(dec(40000, 18), ZERO_ADDRESS, { from: D });

      // Check deposits snapshots are non-zero

      for (depositor of [A, B, C, D]) {
        const snapshot = await stabilityPool.depositSnapshots(depositor);

        const ZERO = toBN("0");
        // Check S,P, G snapshots are non-zero
        assert.isTrue(snapshot[0].eq(S_Before)); // S
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].gt(ZERO)); // GL increases a bit between each depositor op, so just check it is non-zero
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      // All depositors make full withdrawal
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(20000, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(40000, 18), { from: D });

      // Check all depositors' snapshots have been zero'd
      for (depositor of [A, B, C, D]) {
        const snapshot = await stabilityPool.depositSnapshots(depositor);

        // Check S, P, G snapshots are now zero
        assert.equal(snapshot[0], "0"); // S
        assert.equal(snapshot[1], "0"); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("withdrawFromSP(), full withdrawal that reduces front end stake to 0: zero’s the front end’s snapshots", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      //  SETUP: Execute a series of operations to make G, S > 0 and P < 1

      // E opens trove and makes a deposit
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_3, { from: E });

      // Fast-forward time and make a second deposit, to trigger DEFT reward and make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_3, { from: E });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // --- TEST ---

      // A, B open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      // A, B, make their initial deposits
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_2, { from: B });

      // Check frontend snapshots are non-zero
      for (frontEnd of [frontEnd_1, frontEnd_2]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        const ZERO = toBN("0");
        // Check S,P, G snapshots are non-zero
        assert.equal(snapshot[0], "0"); // S  (always zero for front-end)
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].gt(ZERO)); // GL increases a bit between each depositor op, so just check it is non-zero
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      await priceFeed.setPrice(dec(200, 18));

      // All depositors make full withdrawal
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(20000, 18), { from: B });

      // Check all front ends' snapshots have been zero'd
      for (frontEnd of [frontEnd_1, frontEnd_2]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        // Check S, P, G snapshots are now zero
        assert.equal(snapshot[0], "0"); // S  (always zero for front-end)
        assert.equal(snapshot[1], "0"); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("withdrawFromSP(), reverts when initial deposit value is 0", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A opens trove and join the Stability Pool
      await openTrove({
        extraUSDDAmount: toBN(dec(10100, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      //  SETUP: Execute a series of operations to trigger DEFT and ETH rewards for depositor A

      // Fast-forward time and make a second deposit, to trigger DEFT reward and make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await stabilityPool.provideToSP(dec(100, 18), frontEnd_1, { from: A });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      await priceFeed.setPrice(dec(200, 18));

      // A successfully withraws deposit and all gains
      await stabilityPool.withdrawFromSP(dec(10100, 18), { from: A });

      // Confirm A's recorded deposit is 0
      const A_deposit = (await stabilityPool.deposits(A))[0]; // get initialValue property on deposit struct
      assert.equal(A_deposit, "0");

      // --- TEST ---
      const expectedRevertMessage = "StabilityPool: User must have a non-zero deposit";

      // Further withdrawal attempt from A
      const withdrawalPromise_A = stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await th.assertRevert(withdrawalPromise_A, expectedRevertMessage);

      // Withdrawal attempt of a non-existent deposit, from C
      const withdrawalPromise_C = stabilityPool.withdrawFromSP(dec(10000, 18), { from: C });
      await th.assertRevert(withdrawalPromise_C, expectedRevertMessage);
    });

    // --- withdrawCollGainToTrove ---

    it("withdrawCollGainToTrove(): reverts when user has no active deposit", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });

      const alice_initialDeposit = (await stabilityPool.deposits(alice))[0].toString();
      const bob_initialDeposit = (await stabilityPool.deposits(bob))[0].toString();

      assert.equal(alice_initialDeposit, dec(10000, 18));
      assert.equal(bob_initialDeposit, "0");

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      const txAlice = await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      assert.isTrue(txAlice.receipt.status);

      const txPromise_B = stabilityPool.withdrawCollGainToTrove(bob, bob, { from: bob });
      await th.assertRevert(txPromise_B);
    });

    it("withdrawCollGainToTrove(): Applies USDDLoss to user's deposit, and redirects ETH reward to user's Trove", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // Defaulter opens trove
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // check Alice's Trove recorded ETH Before:
      const aliceTrove_Before = await troveManager.Troves(alice);
      const aliceTrove_ETH_Before = aliceTrove_Before[1];
      assert.isTrue(aliceTrove_ETH_Before.gt(toBN("0")));

      // price drops: defaulter's Trove falls below MCR, alice and whale Trove remain active
      await priceFeed.setPrice(dec(105, 18));

      // Defaulter's Trove is closed
      const liquidationTx_1 = await troveManager.liquidate(defaulter_1, { from: owner });
      const [liquidatedDebt, liquidatedColl, ,] = th.getEmittedLiquidationValues(liquidationTx_1);

      const ETHGain_A = await stabilityPool.getDepositorCollGain(alice);
      const compoundedDeposit_A = await stabilityPool.getCompoundedUSDDDeposit(alice);

      // Alice should receive rewards proportional to her deposit as share of total deposits
      const expectedETHGain_A = liquidatedColl.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)));
      const expectedUSDDLoss_A = liquidatedDebt.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)));
      const expectedCompoundedDeposit_A = toBN(dec(15000, 18)).sub(expectedUSDDLoss_A);

      assert.isAtMost(th.getDifference(expectedCompoundedDeposit_A, compoundedDeposit_A), 100000);

      // Alice sends her ETH Gains to her Trove
      await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });

      // check Alice's USDDLoss has been applied to her deposit expectedCompoundedDeposit_A
      alice_deposit_afterDefault = (await stabilityPool.deposits(alice))[0];
      assert.isAtMost(
        th.getDifference(alice_deposit_afterDefault, expectedCompoundedDeposit_A),
        100000
      );

      // check alice's Trove recorded ETH has increased by the expected reward amount
      const aliceTrove_After = await troveManager.Troves(alice);
      const aliceTrove_ETH_After = aliceTrove_After[1];

      const Trove_ETH_Increase = aliceTrove_ETH_After.sub(aliceTrove_ETH_Before).toString();

      assert.equal(Trove_ETH_Increase, ETHGain_A);
    });

    it("withdrawCollGainToTrove(): reverts if it would leave trove with ICR < MCR", async () => {
      // --- SETUP ---
      // Whale deposits 1850 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // defaulter opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // check alice's Trove recorded ETH Before:
      const aliceTrove_Before = await troveManager.Troves(alice);
      const aliceTrove_ETH_Before = aliceTrove_Before[1];
      assert.isTrue(aliceTrove_ETH_Before.gt(toBN("0")));

      // price drops: defaulter's Trove falls below MCR
      await priceFeed.setPrice(dec(10, 18));

      // defaulter's Trove is closed.
      await troveManager.liquidate(defaulter_1, { from: owner });

      // Alice attempts to  her ETH Gains to her Trove
      await assertRevert(
        stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("withdrawCollGainToTrove(): Subsequent deposit and withdrawal attempt from same account, with no intermediate liquidations, withdraws zero ETH", async () => {
      // --- SETUP ---
      // Whale deposits 1850 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // defaulter opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // check alice's Trove recorded ETH Before:
      const aliceTrove_Before = await troveManager.Troves(alice);
      const aliceTrove_ETH_Before = aliceTrove_Before[1];
      assert.isTrue(aliceTrove_ETH_Before.gt(toBN("0")));

      // price drops: defaulter's Trove falls below MCR
      await priceFeed.setPrice(dec(105, 18));

      // defaulter's Trove is closed.
      await troveManager.liquidate(defaulter_1, { from: owner });

      // price bounces back
      await priceFeed.setPrice(dec(200, 18));

      // Alice sends her ETH Gains to her Trove
      await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });

      assert.equal(await stabilityPool.getDepositorCollGain(alice), 0);

      const ETHinSP_Before = (await stabilityPool.getColl()).toString();

      // Alice attempts second withdrawal from SP to Trove - reverts, due to 0 ETH Gain
      const txPromise_A = stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      await th.assertRevert(txPromise_A);

      // Check ETH in pool does not change
      const ETHinSP_1 = (await stabilityPool.getColl()).toString();
      assert.equal(ETHinSP_Before, ETHinSP_1);

      await priceFeed.setPrice(dec(200, 18));

      // Alice attempts third withdrawal (this time, from SP to her own account)
      await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice });

      // Check ETH in pool does not change
      const ETHinSP_2 = (await stabilityPool.getColl()).toString();
      assert.equal(ETHinSP_Before, ETHinSP_2);
    });

    it("withdrawCollGainToTrove(): decreases StabilityPool ETH and increases activePool ETH", async () => {
      // --- SETUP ---
      // Whale deposits 185000 USDD in StabilityPool
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await stabilityPool.provideToSP(dec(185000, 18), frontEnd_1, { from: whale });

      // defaulter opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- TEST ---

      // Alice makes deposit #1: 15000 USDD
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await stabilityPool.provideToSP(dec(15000, 18), frontEnd_1, { from: alice });

      // price drops: defaulter's Trove falls below MCR
      await priceFeed.setPrice(dec(100, 18));

      // defaulter's Trove is closed.
      const liquidationTx = await troveManager.liquidate(defaulter_1);
      const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
        liquidationTx
      );

      // Expect alice to be entitled to 15000/200000 of the liquidated coll
      const aliceExpectedETHGain = liquidatedColl
        .mul(toBN(dec(15000, 18)))
        .div(toBN(dec(200000, 18)));
      const aliceETHGain = await stabilityPool.getDepositorCollGain(alice);
      assert.isTrue(aliceExpectedETHGain.eq(aliceETHGain));

      // price bounces back
      await priceFeed.setPrice(dec(200, 18));

      //check activePool and StabilityPool Ether before retrieval:
      const active_ETH_Before = await activePool.getColl(collToken.address);
      const stability_ETH_Before = await stabilityPool.getColl();

      // Alice retrieves redirects ETH gain to her Trove
      await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });

      const active_ETH_After = await activePool.getColl(collToken.address);
      const stability_ETH_After = await stabilityPool.getColl();

      const active_ETH_Difference = active_ETH_After.sub(active_ETH_Before); // AP ETH should increase
      const stability_ETH_Difference = stability_ETH_Before.sub(stability_ETH_After); // SP ETH should decrease

      // check Pool ETH values change by Alice's ETHGain, i.e 0.075 ETH
      assert.isAtMost(th.getDifference(active_ETH_Difference, aliceETHGain), 10000);
      assert.isAtMost(th.getDifference(stability_ETH_Difference, aliceETHGain), 10000);
    });

    it("withdrawCollGainToTrove(): All depositors are able to withdraw their ETH gain from the SP to their Trove", async () => {
      // Whale opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // Defaulter opens trove
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // 6 Accounts open troves and provide to SP
      const depositors = [alice, bob, carol, dennis, erin, flyn];
      for (account of depositors) {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: account }
        });
        await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: account });
      }

      await priceFeed.setPrice(dec(105, 18));
      await troveManager.liquidate(defaulter_1);

      // price bounces back
      await priceFeed.setPrice(dec(200, 18));

      // All depositors attempt to withdraw
      const tx1 = await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      assert.isTrue(tx1.receipt.status);
      const tx2 = await stabilityPool.withdrawCollGainToTrove(bob, bob, { from: bob });
      assert.isTrue(tx1.receipt.status);
      const tx3 = await stabilityPool.withdrawCollGainToTrove(carol, carol, { from: carol });
      assert.isTrue(tx1.receipt.status);
      const tx4 = await stabilityPool.withdrawCollGainToTrove(dennis, dennis, { from: dennis });
      assert.isTrue(tx1.receipt.status);
      const tx5 = await stabilityPool.withdrawCollGainToTrove(erin, erin, { from: erin });
      assert.isTrue(tx1.receipt.status);
      const tx6 = await stabilityPool.withdrawCollGainToTrove(flyn, flyn, { from: flyn });
      assert.isTrue(tx1.receipt.status);
    });

    it("withdrawCollGainToTrove(): All depositors withdraw, each withdraw their correct ETH gain", async () => {
      // Whale opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // defaulter opened
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // 6 Accounts open troves and provide to SP
      const depositors = [alice, bob, carol, dennis, erin, flyn];
      for (account of depositors) {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: account }
        });
        await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: account });
      }
      const collBefore = (await troveManager.Troves(alice))[1]; // all troves have same coll before

      await priceFeed.setPrice(dec(105, 18));
      const liquidationTx = await troveManager.liquidate(defaulter_1);
      const [, liquidatedColl, ,] = th.getEmittedLiquidationValues(liquidationTx);

      /* All depositors attempt to withdraw their ETH gain to their Trove. Each depositor 
      receives (liquidatedColl/ 6).

      Thus, expected new collateral for each depositor with 1 Ether in their trove originally, is 
      (1 + liquidatedColl/6)
      */

      const expectedCollGain = liquidatedColl.div(toBN("6"));

      await priceFeed.setPrice(dec(200, 18));

      await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      const aliceCollAfter = (await troveManager.Troves(alice))[1];
      assert.isAtMost(th.getDifference(aliceCollAfter.sub(collBefore), expectedCollGain), 10000);

      await stabilityPool.withdrawCollGainToTrove(bob, bob, { from: bob });
      const bobCollAfter = (await troveManager.Troves(bob))[1];
      assert.isAtMost(th.getDifference(bobCollAfter.sub(collBefore), expectedCollGain), 10000);

      await stabilityPool.withdrawCollGainToTrove(carol, carol, { from: carol });
      const carolCollAfter = (await troveManager.Troves(carol))[1];
      assert.isAtMost(th.getDifference(carolCollAfter.sub(collBefore), expectedCollGain), 10000);

      await stabilityPool.withdrawCollGainToTrove(dennis, dennis, { from: dennis });
      const dennisCollAfter = (await troveManager.Troves(dennis))[1];
      assert.isAtMost(th.getDifference(dennisCollAfter.sub(collBefore), expectedCollGain), 10000);

      await stabilityPool.withdrawCollGainToTrove(erin, erin, { from: erin });
      const erinCollAfter = (await troveManager.Troves(erin))[1];
      assert.isAtMost(th.getDifference(erinCollAfter.sub(collBefore), expectedCollGain), 10000);

      await stabilityPool.withdrawCollGainToTrove(flyn, flyn, { from: flyn });
      const flynCollAfter = (await troveManager.Troves(flyn))[1];
      assert.isAtMost(th.getDifference(flynCollAfter.sub(collBefore), expectedCollGain), 10000);
    });

    it("withdrawCollGainToTrove(): caller can withdraw full deposit and ETH gain to their trove during Recovery Mode", async () => {
      // --- SETUP ---

      // Defaulter opens
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // A, B, C provides 10000, 5000, 3000 USDD to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: alice });
      await stabilityPool.provideToSP(dec(5000, 18), frontEnd_1, { from: bob });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_1, { from: carol });

      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Price drops to 105,
      await priceFeed.setPrice(dec(105, 18));
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Check defaulter 1 has ICR: 100% < ICR < 110%.
      assert.isTrue(await th.ICRbetween100and110(defaulter_1, troveManager, price));

      const alice_Collateral_Before = (await troveManager.Troves(alice))[1];
      const bob_Collateral_Before = (await troveManager.Troves(bob))[1];
      const carol_Collateral_Before = (await troveManager.Troves(carol))[1];

      // Liquidate defaulter 1
      assert.isTrue(await sortedTroves.contains(defaulter_1));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      const alice_ETHGain_Before = await stabilityPool.getDepositorCollGain(alice);
      const bob_ETHGain_Before = await stabilityPool.getDepositorCollGain(bob);
      const carol_ETHGain_Before = await stabilityPool.getDepositorCollGain(carol);

      // A, B, C withdraw their full ETH gain from the Stability Pool to their trove
      await stabilityPool.withdrawCollGainToTrove(alice, alice, { from: alice });
      await stabilityPool.withdrawCollGainToTrove(bob, bob, { from: bob });
      await stabilityPool.withdrawCollGainToTrove(carol, carol, { from: carol });

      // Check collateral of troves A, B, C has increased by the value of their ETH gain from liquidations, respectively
      const alice_expectedCollateral = alice_Collateral_Before.add(alice_ETHGain_Before).toString();
      const bob_expectedColalteral = bob_Collateral_Before.add(bob_ETHGain_Before).toString();
      const carol_expectedCollateral = carol_Collateral_Before.add(carol_ETHGain_Before).toString();

      const alice_Collateral_After = (await troveManager.Troves(alice))[1];
      const bob_Collateral_After = (await troveManager.Troves(bob))[1];
      const carol_Collateral_After = (await troveManager.Troves(carol))[1];

      assert.equal(alice_expectedCollateral, alice_Collateral_After);
      assert.equal(bob_expectedColalteral, bob_Collateral_After);
      assert.equal(carol_expectedCollateral, carol_Collateral_After);

      // Check ETH in SP has reduced to zero
      const ETHinSP_After = (await stabilityPool.getColl()).toString();
      assert.isAtMost(th.getDifference(ETHinSP_After, "0"), 100000);
    });

    it("withdrawCollGainToTrove(): reverts if user has no trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // Defaulter opens
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // A transfers USDD to D
      await usddToken.transfer(dennis, dec(10000, 18), { from: alice });

      // D deposits to Stability Pool
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: dennis });

      //Price drops
      await priceFeed.setPrice(dec(105, 18));

      //Liquidate defaulter 1
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      await priceFeed.setPrice(dec(200, 18));

      // D attempts to withdraw his ETH gain to Trove
      await th.assertRevert(
        stabilityPool.withdrawCollGainToTrove(dennis, dennis, { from: dennis }),
        "caller must have an active trove to withdraw ETHGain to"
      );
    });

    it("withdrawCollGainToTrove(): triggers DEFT reward event - increases the sum G", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A and B provide to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: B });

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      const G_Before = await stabilityPool.epochToScaleToG(0, 0);

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      await priceFeed.setPrice(dec(200, 18));

      // A withdraws from SP
      await stabilityPool.withdrawFromSP(dec(50, 18), { from: A });

      const G_1 = await stabilityPool.epochToScaleToG(0, 0);

      // Expect G has increased from the DEFT reward event triggered
      assert.isTrue(G_1.gt(G_Before));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Check B has non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));

      // B withdraws to trove
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });

      const G_2 = await stabilityPool.epochToScaleToG(0, 0);

      // Expect G has increased from the DEFT reward event triggered
      assert.isTrue(G_2.gt(G_1));
    });

    it("withdrawCollGainToTrove(), partial withdrawal: doesn't change the front end tag", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, D, E provide to SP
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), ZERO_ADDRESS, { from: C });

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Check A, B, C have non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(A)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(C)).gt(ZERO));

      await priceFeed.setPrice(dec(200, 18));

      // A, B, C withdraw to trove
      await stabilityPool.withdrawCollGainToTrove(A, A, { from: A });
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });
      await stabilityPool.withdrawCollGainToTrove(C, C, { from: C });

      const frontEndTag_A = (await stabilityPool.deposits(A))[1];
      const frontEndTag_B = (await stabilityPool.deposits(B))[1];
      const frontEndTag_C = (await stabilityPool.deposits(C))[1];

      // Check deposits are still tagged with their original front end
      assert.equal(frontEndTag_A, frontEnd_1);
      assert.equal(frontEndTag_B, frontEnd_2);
      assert.equal(frontEndTag_C, ZERO_ADDRESS);
    });

    it("withdrawCollGainToTrove(), eligible deposit: depositor receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(3000, 18), ZERO_ADDRESS, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      // Get A, B, C DEFT balance before
      const A_DEFTBalance_Before = await deftToken.balanceOf(A);
      const B_DEFTBalance_Before = await deftToken.balanceOf(B);
      const C_DEFTBalance_Before = await deftToken.balanceOf(C);

      // Check A, B, C have non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(A)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(C)).gt(ZERO));

      await priceFeed.setPrice(dec(200, 18));

      // A, B, C withdraw to trove
      await stabilityPool.withdrawCollGainToTrove(A, A, { from: A });
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });
      await stabilityPool.withdrawCollGainToTrove(C, C, { from: C });

      // Get DEFT balance after
      const A_DEFTBalance_After = await deftToken.balanceOf(A);
      const B_DEFTBalance_After = await deftToken.balanceOf(B);
      const C_DEFTBalance_After = await deftToken.balanceOf(C);

      // Check DEFT Balance of A, B, C has increased
      assert.isTrue(A_DEFTBalance_After.gt(A_DEFTBalance_Before));
      assert.isTrue(B_DEFTBalance_After.gt(B_DEFTBalance_Before));
      assert.isTrue(C_DEFTBalance_After.gt(C_DEFTBalance_Before));
    });

    it("withdrawCollGainToTrove(), eligible deposit: tagged front end receives DEFT rewards", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // A, B, C, provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: C });

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      // Get front ends' DEFT balance before
      const F1_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_1);
      const F2_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_2);
      const F3_DEFTBalance_Before = await deftToken.balanceOf(frontEnd_3);

      await priceFeed.setPrice(dec(200, 18));

      // Check A, B, C have non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(A)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(C)).gt(ZERO));

      // A, B, C withdraw
      await stabilityPool.withdrawCollGainToTrove(A, A, { from: A });
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });
      await stabilityPool.withdrawCollGainToTrove(C, C, { from: C });

      // Get front ends' DEFT balance after
      const F1_DEFTBalance_After = await deftToken.balanceOf(frontEnd_1);
      const F2_DEFTBalance_After = await deftToken.balanceOf(frontEnd_2);
      const F3_DEFTBalance_After = await deftToken.balanceOf(frontEnd_3);

      // Check DEFT Balance of front ends has increased
      assert.isTrue(F1_DEFTBalance_After.gt(F1_DEFTBalance_Before));
      assert.isTrue(F2_DEFTBalance_After.gt(F2_DEFTBalance_Before));
      assert.isTrue(F3_DEFTBalance_After.gt(F3_DEFTBalance_Before));
    });

    it("withdrawCollGainToTrove(), eligible deposit: tagged front end's stake decreases", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, D, E, F open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: F }
      });

      // A, B, C, D, E, F provide to SP
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: C });
      await stabilityPool.provideToSP(dec(1000, 18), frontEnd_1, { from: D });
      await stabilityPool.provideToSP(dec(2000, 18), frontEnd_2, { from: E });
      await stabilityPool.provideToSP(dec(3000, 18), frontEnd_3, { from: F });

      // Defaulter opens a trove, price drops, defaulter gets liquidated
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      // Get front ends' stake before
      const F1_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_Before = await stabilityPool.frontEndStakes(frontEnd_3);

      await priceFeed.setPrice(dec(200, 18));

      // Check A, B, C have non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(A)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(C)).gt(ZERO));

      // A, B, C withdraw to trove
      await stabilityPool.withdrawCollGainToTrove(A, A, { from: A });
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });
      await stabilityPool.withdrawCollGainToTrove(C, C, { from: C });

      // Get front ends' stakes after
      const F1_Stake_After = await stabilityPool.frontEndStakes(frontEnd_1);
      const F2_Stake_After = await stabilityPool.frontEndStakes(frontEnd_2);
      const F3_Stake_After = await stabilityPool.frontEndStakes(frontEnd_3);

      // Check front ends' stakes have decreased
      assert.isTrue(F1_Stake_After.lt(F1_Stake_Before));
      assert.isTrue(F2_Stake_After.lt(F2_Stake_Before));
      assert.isTrue(F3_Stake_After.lt(F3_Stake_Before));
    });

    it("withdrawCollGainToTrove(), eligible deposit: tagged front end's snapshots update", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // A, B, C, open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(60000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

      // --- SETUP ---

      const deposit_A = dec(100, 18);
      const deposit_B = dec(200, 18);
      const deposit_C = dec(300, 18);

      // A, B, C make their initial deposits
      await stabilityPool.provideToSP(deposit_A, frontEnd_1, { from: A });
      await stabilityPool.provideToSP(deposit_B, frontEnd_2, { from: B });
      await stabilityPool.provideToSP(deposit_C, frontEnd_3, { from: C });

      // fastforward time then make an SP deposit, to make G > 0
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);

      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: D });

      // perform a liquidation to make 0 < P < 1, and S > 0
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await troveManager.liquidate(defaulter_1);

      const currentEpoch = await stabilityPool.currentEpoch();
      const currentScale = await stabilityPool.currentScale();

      const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale);
      const P_Before = await stabilityPool.P();
      const G_Before = await stabilityPool.epochToScaleToG(currentEpoch, currentScale);

      // Confirm 0 < P < 1
      assert.isTrue(P_Before.gt(toBN("0")) && P_Before.lt(toBN(dec(1, 18))));
      // Confirm S, G are both > 0
      assert.isTrue(S_Before.gt(toBN("0")));
      assert.isTrue(G_Before.gt(toBN("0")));

      // Get front ends' snapshots before
      for (frontEnd of [frontEnd_1, frontEnd_2, frontEnd_3]) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends, since S corresponds to ETH gain)
        assert.equal(snapshot[1], dec(1, 18)); // P
        assert.equal(snapshot[2], "0"); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }

      // --- TEST ---

      // Check A, B, C have non-zero ETH gain
      assert.isTrue((await stabilityPool.getDepositorCollGain(A)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(B)).gt(ZERO));
      assert.isTrue((await stabilityPool.getDepositorCollGain(C)).gt(ZERO));

      await priceFeed.setPrice(dec(200, 18));

      // A, B, C withdraw ETH gain to troves. Grab G at each stage, as it can increase a bit
      // between topups, because some block.timestamp time passes (and DEFT is issued) between ops
      const G1 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawCollGainToTrove(A, A, { from: A });

      const G2 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawCollGainToTrove(B, B, { from: B });

      const G3 = await stabilityPool.epochToScaleToG(currentScale, currentEpoch);
      await stabilityPool.withdrawCollGainToTrove(C, C, { from: C });

      const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3];
      const G_Values = [G1, G2, G3];

      // Map frontEnds to the value of G at time the deposit was made
      frontEndToG = th.zipToObject(frontEnds, G_Values);

      // Get front ends' snapshots after
      for (const [frontEnd, G] of Object.entries(frontEndToG)) {
        const snapshot = await stabilityPool.frontEndSnapshots(frontEnd);

        // Check snapshots are the expected values
        assert.equal(snapshot[0], "0"); // S (should always be 0 for front ends)
        assert.isTrue(snapshot[1].eq(P_Before)); // P
        assert.isTrue(snapshot[2].eq(G)); // G
        assert.equal(snapshot[3], "0"); // scale
        assert.equal(snapshot[4], "0"); // epoch
      }
    });

    it("withdrawCollGainToTrove(): reverts when depositor has no ETH gain", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      // Whale transfers USDD to A, B
      await usddToken.transfer(A, dec(10000, 18), { from: whale });
      await usddToken.transfer(B, dec(20000, 18), { from: whale });

      // C, D open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(4000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // A, B, C, D provide to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(30, 18), frontEnd_2, { from: C });
      await stabilityPool.provideToSP(dec(40, 18), ZERO_ADDRESS, { from: D });

      // fastforward time, and E makes a deposit, creating DEFT rewards for all
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await openTrove({
        extraUSDDAmount: toBN(dec(3000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await stabilityPool.provideToSP(dec(3000, 18), ZERO_ADDRESS, { from: E });

      // Confirm A, B, C have zero ETH gain
      assert.equal(await stabilityPool.getDepositorCollGain(A), "0");
      assert.equal(await stabilityPool.getDepositorCollGain(B), "0");
      assert.equal(await stabilityPool.getDepositorCollGain(C), "0");

      // Check withdrawCollGainToTrove reverts for A, B, C
      const txPromise_A = stabilityPool.withdrawCollGainToTrove(A, A, { from: A });
      const txPromise_B = stabilityPool.withdrawCollGainToTrove(B, B, { from: B });
      const txPromise_C = stabilityPool.withdrawCollGainToTrove(C, C, { from: C });
      const txPromise_D = stabilityPool.withdrawCollGainToTrove(D, D, { from: D });

      await th.assertRevert(txPromise_A);
      await th.assertRevert(txPromise_B);
      await th.assertRevert(txPromise_C);
      await th.assertRevert(txPromise_D);
    });

    it("registerFrontEnd(): registers the front end and chosen kickback rate", async () => {
      const unregisteredFrontEnds = [A, B, C, D, E];

      for (const frontEnd of unregisteredFrontEnds) {
        assert.isFalse((await stabilityPool.frontEnds(frontEnd))[1]); // check inactive
        assert.equal((await stabilityPool.frontEnds(frontEnd))[0], "0"); // check no chosen kickback rate
      }

      await stabilityPool.registerFrontEnd(dec(1, 18), { from: A });
      await stabilityPool.registerFrontEnd("897789897897897", { from: B });
      await stabilityPool.registerFrontEnd("99990098", { from: C });
      await stabilityPool.registerFrontEnd("37", { from: D });
      await stabilityPool.registerFrontEnd("0", { from: E });

      // Check front ends are registered as active, and have correct kickback rates
      assert.isTrue((await stabilityPool.frontEnds(A))[1]);
      assert.equal((await stabilityPool.frontEnds(A))[0], dec(1, 18));

      assert.isTrue((await stabilityPool.frontEnds(B))[1]);
      assert.equal((await stabilityPool.frontEnds(B))[0], "897789897897897");

      assert.isTrue((await stabilityPool.frontEnds(C))[1]);
      assert.equal((await stabilityPool.frontEnds(C))[0], "99990098");

      assert.isTrue((await stabilityPool.frontEnds(D))[1]);
      assert.equal((await stabilityPool.frontEnds(D))[0], "37");

      assert.isTrue((await stabilityPool.frontEnds(E))[1]);
      assert.equal((await stabilityPool.frontEnds(E))[0], "0");
    });

    it("registerFrontEnd(): reverts if the front end is already registered", async () => {
      await stabilityPool.registerFrontEnd(dec(1, 18), { from: A });
      await stabilityPool.registerFrontEnd("897789897897897", { from: B });
      await stabilityPool.registerFrontEnd("99990098", { from: C });

      const _2ndAttempt_A = stabilityPool.registerFrontEnd(dec(1, 18), { from: A });
      const _2ndAttempt_B = stabilityPool.registerFrontEnd("897789897897897", { from: B });
      const _2ndAttempt_C = stabilityPool.registerFrontEnd("99990098", { from: C });

      await th.assertRevert(
        _2ndAttempt_A,
        "StabilityPool: must not already be a registered front end"
      );
      await th.assertRevert(
        _2ndAttempt_B,
        "StabilityPool: must not already be a registered front end"
      );
      await th.assertRevert(
        _2ndAttempt_C,
        "StabilityPool: must not already be a registered front end"
      );
    });

    it("registerFrontEnd(): reverts if the kickback rate >1", async () => {
      const invalidKickbackTx_A = stabilityPool.registerFrontEnd(dec(1, 19), { from: A });
      const invalidKickbackTx_B = stabilityPool.registerFrontEnd("1000000000000000001", { from: A });
      const invalidKickbackTx_C = stabilityPool.registerFrontEnd(dec(23423, 45), { from: A });
      const invalidKickbackTx_D = stabilityPool.registerFrontEnd(maxBytes32, { from: A });

      await th.assertRevert(
        invalidKickbackTx_A,
        "StabilityPool: Kickback rate must be in range [0,1]"
      );
      await th.assertRevert(
        invalidKickbackTx_B,
        "StabilityPool: Kickback rate must be in range [0,1]"
      );
      await th.assertRevert(
        invalidKickbackTx_C,
        "StabilityPool: Kickback rate must be in range [0,1]"
      );
      await th.assertRevert(
        invalidKickbackTx_D,
        "StabilityPool: Kickback rate must be in range [0,1]"
      );
    });

    it("registerFrontEnd(): reverts if address has a non-zero deposit already", async () => {
      // C, D, E open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      // C, E provides to SP
      await stabilityPool.provideToSP(dec(10, 18), frontEnd_1, { from: C });
      await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: E });

      const txPromise_C = stabilityPool.registerFrontEnd(dec(1, 18), { from: C });
      const txPromise_E = stabilityPool.registerFrontEnd(dec(1, 18), { from: E });
      await th.assertRevert(txPromise_C, "StabilityPool: User must have no deposit");
      await th.assertRevert(txPromise_E, "StabilityPool: User must have no deposit");

      // D, with no deposit, successfully registers a front end
      const txD = await stabilityPool.registerFrontEnd(dec(1, 18), { from: D });
      assert.isTrue(txD.receipt.status);
    });
  });
});

contract("Reset chain state", async accounts => {});
