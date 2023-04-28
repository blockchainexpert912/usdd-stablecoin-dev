const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const NonPayable = artifacts.require("NonPayable.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const USDDTokenTester = artifacts.require("./USDDTokenTester");

const th = testHelpers.TestHelper;

const dec = th.dec;
const toBN = th.toBN;
const mv = testHelpers.MoneyValues;
const timeValues = testHelpers.TimeValues;

const ZERO_ADDRESS = th.ZERO_ADDRESS;
const assertRevert = th.assertRevert;

/* NOTE: Some of the borrowing tests do not test for specific USDD fee values. They only test that the
 * fees are non-zero when they should occur, and that they decay over time.
 *
 * Specific USDD fee values will depend on the final fee schedule used, and the final choice for
 *  the parameter MINUTE_DECAY_FACTOR in the TroveManager, which is still TBD based on economic
 * modelling.
 *
 */

contract("BorrowerOperations", async accounts => {
  const [
    owner,
    alice,
    bob,
    carol,
    dennis,
    whale,
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    // defaulter_1, defaulter_2,
    frontEnd_1,
    frontEnd_2,
    frontEnd_3
  ] = accounts;

  // const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3]

  let priceFeed;
  let usddToken;
  let sortedTroves;
  let troveManager;
  let activePool;
  let stabilityPool;
  let defaultPool;
  let borrowerOperations;
  let deftStaking;
  let deftToken;
  let collToken;

  let contracts;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);
  const getNetBorrowingAmount = async debtWithFee =>
    th.getNetBorrowingAmount(contracts, debtWithFee);
  const getActualDebtFromComposite = async compositeDebt =>
    th.getActualDebtFromComposite(compositeDebt, contracts);
  const openTrove = async params => th.openTrove(contracts, params);
  const addColl = async params => th.addColl(contracts, params);
  const adjustTrove = async params => th.adjustTrove(contracts, params);
  const getTroveEntireColl = async trove => th.getTroveEntireColl(contracts, trove);
  const getTroveEntireDebt = async trove => th.getTroveEntireDebt(contracts, trove);
  const getTroveStake = async trove => th.getTroveStake(contracts, trove);

  let USDD_GAS_COMPENSATION;
  let MIN_NET_DEBT;
  let BORROWING_FEE_FLOOR;

  before(async () => {});

  const testCorpus = ({ withProxy = false }) => {
    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore();
      contracts.borrowerOperations = await BorrowerOperationsTester.new();
      contracts.troveManager = await TroveManagerTester.new();
      contracts = await deploymentHelper.deployUSDDTokenTester(contracts);
      const DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();

      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

      if (withProxy) {
        const users = [alice, bob, carol, dennis, whale, A, B, C, D, E];
        await deploymentHelper.deployProxyScripts(contracts, DEFTContracts, owner, users);
      }

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

      deftStaking = DEFTContracts.deftStaking;
      deftToken = DEFTContracts.deftToken;
      communityIssuance = DEFTContracts.communityIssuance;

      USDD_GAS_COMPENSATION = await borrowerOperations.USDD_GAS_COMPENSATION();
      MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT();
      BORROWING_FEE_FLOOR = await borrowerOperations.BORROWING_FEE_FLOOR();

      await deftToken.mint(alice, dec(100, 18));
    });

    it("addColl(): reverts when top-up would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      assert.isFalse(await troveManager.checkRecoveryMode(price));
      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))));

      const collTopUp = 1; // 1 wei top up

      await assertRevert(
        addColl({
          collAmount: toBN(collTopUp),
          upperHint: alice,
          lowerHint: alice,
          extraParams: { from: alice }
        }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("addColl(): Increases the activePool ETH and raw ether balance by correct amount", async () => {
      const { collateral: aliceColl } = await openTrove({
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const activePool_ETH_Before = await activePool.getColl(collToken.address);
      const activePool_RawEther_Before = toBN(await collToken.balanceOf(activePool.address));

      assert.isTrue(activePool_ETH_Before.eq(aliceColl));
      assert.isTrue(activePool_RawEther_Before.eq(aliceColl));

      await addColl({
        collAmount: toBN(dec(1, "ether")),
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(aliceColl.add(toBN(dec(1, "ether")))));
      assert.isTrue(activePool_RawEther_After.eq(aliceColl.add(toBN(dec(1, "ether")))));
    });

    it("addColl(), active Trove: adds the correct collateral amount to the Trove", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      const alice_Trove_Before = await troveManager.Troves(alice);
      const coll_before = alice_Trove_Before[1];
      const status_Before = alice_Trove_Before[3];

      // check status before
      assert.equal(status_Before, 1);

      // Alice adds second collateral
      await addColl({
        collAmount: toBN(dec(1, "ether")),
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      const alice_Trove_After = await troveManager.Troves(alice);
      const coll_After = alice_Trove_After[1];
      const status_After = alice_Trove_After[3];

      // check coll increases by correct amount,and status remains active
      assert.isTrue(coll_After.eq(coll_before.add(toBN(dec(1, "ether")))));
      assert.equal(status_After, 1);
    });

    it("addColl(), active Trove: Trove is in sortedList before and after", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      // check Alice is in list before
      const aliceTroveInList_Before = await sortedTroves.contains(alice);
      const listIsEmpty_Before = await sortedTroves.isEmpty();
      assert.equal(aliceTroveInList_Before, true);
      assert.equal(listIsEmpty_Before, false);

      await addColl({
        collAmount: toBN(dec(1, "ether")),
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      // check Alice is still in list after
      const aliceTroveInList_After = await sortedTroves.contains(alice);
      const listIsEmpty_After = await sortedTroves.isEmpty();
      assert.equal(aliceTroveInList_After, true);
      assert.equal(listIsEmpty_After, false);
    });

    it("addColl(), active Trove: updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 1 ether
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      const alice_Trove_Before = await troveManager.Troves(alice);
      const alice_Stake_Before = alice_Trove_Before[2];
      const totalStakes_Before = await troveManager.totalStakes();

      assert.isTrue(totalStakes_Before.eq(alice_Stake_Before));

      // Alice tops up Trove collateral with 2 ether
      await addColl({
        collAmount: toBN(dec(2, "ether")),
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice);
      const alice_Stake_After = alice_Trove_After[2];
      const totalStakes_After = await troveManager.totalStakes();

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.add(toBN(dec(2, "ether")))));
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.add(toBN(dec(2, "ether")))));
    });

    it("addColl(), active Trove: applies pending rewards and updates user's L_ETH, L_USDDDebt snapshots", async () => {
      // --- SETUP ---

      const { collateral: aliceCollBefore, totalDebt: aliceDebtBefore } = await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      const { collateral: bobCollBefore, totalDebt: bobDebtBefore } = await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // --- TEST ---

      // price drops to 1ETH:100USDD, reducing Carol's ICR below MCR
      await priceFeed.setPrice("100000000000000000000");

      // Liquidate Carol's Trove,
      const tx = await troveManager.liquidate(carol, { from: owner });

      assert.isFalse(await sortedTroves.contains(carol));

      const L_ETH = await troveManager.L_COLL();
      const L_USDDDebt = await troveManager.L_USDDDebt();

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice);
      const alice_ETHrewardSnapshot_Before = alice_rewardSnapshot_Before[0];
      const alice_USDDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1];

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot_Before = bob_rewardSnapshot_Before[0];
      const bob_USDDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1];

      assert.equal(alice_ETHrewardSnapshot_Before, 0);
      assert.equal(alice_USDDDebtRewardSnapshot_Before, 0);
      assert.equal(bob_ETHrewardSnapshot_Before, 0);
      assert.equal(bob_USDDDebtRewardSnapshot_Before, 0);

      const alicePendingETHReward = await troveManager.getPendingCollReward(alice);
      const bobPendingETHReward = await troveManager.getPendingCollReward(bob);
      const alicePendingUSDDDebtReward = await troveManager.getPendingUSDDDebtReward(alice);
      const bobPendingUSDDDebtReward = await troveManager.getPendingUSDDDebtReward(bob);
      for (reward of [
        alicePendingETHReward,
        bobPendingETHReward,
        alicePendingUSDDDebtReward,
        bobPendingUSDDDebtReward
      ]) {
        assert.isTrue(reward.gt(toBN("0")));
      }

      // Alice and Bob top up their Troves
      const aliceTopUp = toBN(dec(5, "ether"));
      const bobTopUp = toBN(dec(1, "ether"));

      await addColl({
        collAmount: aliceTopUp,
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      await addColl({
        collAmount: bobTopUp,
        upperHint: bob,
        lowerHint: bob,
        extraParams: { from: bob }
      });

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups.
      const aliceNewColl = await getTroveEntireColl(alice);
      const aliceNewDebt = await getTroveEntireDebt(alice);
      const bobNewColl = await getTroveEntireColl(bob);
      const bobNewDebt = await getTroveEntireDebt(bob);

      assert.isTrue(aliceNewColl.eq(aliceCollBefore.add(alicePendingETHReward).add(aliceTopUp)));
      assert.isTrue(aliceNewDebt.eq(aliceDebtBefore.add(alicePendingUSDDDebtReward)));
      assert.isTrue(bobNewColl.eq(bobCollBefore.add(bobPendingETHReward).add(bobTopUp)));
      assert.isTrue(bobNewDebt.eq(bobDebtBefore.add(bobPendingUSDDDebtReward)));

      /* Check that both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_ETH and L_USDDDebt */
      const alice_rewardSnapshot_After = await troveManager.rewardSnapshots(alice);
      const alice_ETHrewardSnapshot_After = alice_rewardSnapshot_After[0];
      const alice_USDDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1];

      const bob_rewardSnapshot_After = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot_After = bob_rewardSnapshot_After[0];
      const bob_USDDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1];

      assert.isAtMost(th.getDifference(alice_ETHrewardSnapshot_After, L_ETH), 100);
      assert.isAtMost(th.getDifference(alice_USDDDebtRewardSnapshot_After, L_USDDDebt), 100);
      assert.isAtMost(th.getDifference(bob_ETHrewardSnapshot_After, L_ETH), 100);
      assert.isAtMost(th.getDifference(bob_USDDDebtRewardSnapshot_After, L_USDDDebt), 100);
    });

    // it("addColl(), active Trove: adds the right corrected stake after liquidations have occured", async () => {
    //  // TODO - check stake updates for addColl/withdrawColl/adustTrove ---

    //   // --- SETUP ---
    //   // A,B,C add 15/5/5 ETH, withdraw 100/100/900 USDD
    //   await borrowerOperations.openTrove(th._100pct, dec(100, 18), alice, alice, { from: alice, value: dec(15, 'ether') })
    //   await borrowerOperations.openTrove(th._100pct, dec(100, 18), bob, bob, { from: bob, value: dec(4, 'ether') })
    //   await borrowerOperations.openTrove(th._100pct, dec(900, 18), carol, carol, { from: carol, value: dec(5, 'ether') })

    //   await borrowerOperations.openTrove(th._100pct, 0, dennis, dennis, { from: dennis, value: dec(1, 'ether') })
    //   // --- TEST ---

    //   // price drops to 1ETH:100USDD, reducing Carol's ICR below MCR
    //   await priceFeed.setPrice('100000000000000000000');

    //   // close Carol's Trove, liquidating her 5 ether and 900USDD.
    //   await troveManager.liquidate(carol, { from: owner });

    //   // dennis tops up his trove by 1 ETH
    //   await borrowerOperations.addColl(dennis, dennis, { from: dennis, value: dec(1, 'ether') })

    //   /* Check that Dennis's recorded stake is the right corrected stake, less than his collateral. A corrected
    //   stake is given by the formula:

    //   s = totalStakesSnapshot / totalCollateralSnapshot

    //   where snapshots are the values immediately after the last liquidation.  After Carol's liquidation,
    //   the ETH from her Trove has now become the totalPendingETHReward. So:

    //   totalStakes = (alice_Stake + bob_Stake + dennis_orig_stake ) = (15 + 4 + 1) =  20 ETH.
    //   totalCollateral = (alice_Collateral + bob_Collateral + dennis_orig_coll + totalPendingETHReward) = (15 + 4 + 1 + 5)  = 25 ETH.

    //   Therefore, as Dennis adds 1 ether collateral, his corrected stake should be:  s = 2 * (20 / 25 ) = 1.6 ETH */
    //   const dennis_Trove = await troveManager.Troves(dennis)

    //   const dennis_Stake = dennis_Trove[2]
    //   console.log(dennis_Stake.toString())

    //   assert.isAtMost(th.getDifference(dennis_Stake), 100)
    // })

    it("addColl(), reverts if trove is non-existent or closed", async () => {
      // A, B open troves
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });

      // Carol attempts to add collateral to her non-existent trove
      try {
        const txCarol = await addColl({
          collAmount: toBN(dec(1, "ether")),
          upperHint: carol,
          lowerHint: carol,
          extraParams: { from: carol }
        });
        assert.isFalse(txCarol.receipt.status);
      } catch (error) {
        assert.include(error.message, "revert");
        assert.include(error.message, "Trove does not exist or is closed");
      }

      // Price drops
      await priceFeed.setPrice(dec(100, 18));

      // Bob gets liquidated
      await troveManager.liquidate(bob);

      assert.isFalse(await sortedTroves.contains(bob));

      // Bob attempts to add collateral to his closed trove
      try {
        const txBob = await addColl({
          collAmount: toBN(dec(1, "ether")),
          upperHint: bob,
          lowerHint: bob,
          extraParams: { from: bob }
        });
        assert.isFalse(txBob.receipt.status);
      } catch (error) {
        assert.include(error.message, "revert");
        assert.include(error.message, "Trove does not exist or is closed");
      }
    });

    it("addColl(): can add collateral in Recovery Mode", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      const aliceCollBefore = await getTroveEntireColl(alice);
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice("105000000000000000000");

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const collTopUp = toBN(dec(1, "ether"));
      await addColl({
        collAmount: collTopUp,
        upperHint: alice,
        lowerHint: alice,
        extraParams: { from: alice }
      });

      // Check Alice's collateral
      const aliceCollAfter = (await troveManager.Troves(alice))[1];
      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.add(collTopUp)));
    });

    // --- withdrawColl() ---

    it("withdrawColl(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      assert.isFalse(await troveManager.checkRecoveryMode(price));
      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))));

      const collWithdrawal = 1; // 1 wei withdrawal

      await assertRevert(
        borrowerOperations.withdrawColl(1, alice, alice, { from: alice }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    // reverts when calling address does not have active trove
    it("withdrawColl(): reverts when calling address does not have active trove", async () => {
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

      // Bob successfully withdraws some coll
      const txBob = await borrowerOperations.withdrawColl(dec(100, "finney"), bob, bob, {
        from: bob
      });
      assert.isTrue(txBob.receipt.status);

      // Carol with no active trove attempts to withdraw
      try {
        const txCarol = await borrowerOperations.withdrawColl(dec(1, "ether"), carol, carol, {
          from: carol
        });
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawColl(): reverts when system is in Recovery Mode", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });

      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Withdrawal possible when recoveryMode == false
      const txAlice = await borrowerOperations.withdrawColl(1000, alice, alice, { from: alice });
      assert.isTrue(txAlice.receipt.status);

      await priceFeed.setPrice("105000000000000000000");

      assert.isTrue(await th.checkRecoveryMode(contracts));

      //Check withdrawal impossible when recoveryMode == true
      try {
        const txBob = await borrowerOperations.withdrawColl(1000, bob, bob, { from: bob });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawColl(): reverts when requested ETH withdrawal is > the trove's collateral", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } });

      const carolColl = await getTroveEntireColl(carol);
      const bobColl = await getTroveEntireColl(bob);
      // Carol withdraws exactly all her collateral
      await assertRevert(
        borrowerOperations.withdrawColl(carolColl, carol, carol, { from: carol }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );

      // Bob attempts to withdraw 1 wei more than his collateral
      try {
        const txBob = await borrowerOperations.withdrawColl(bobColl.add(toBN(1)), bob, bob, {
          from: bob
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawColl(): reverts when withdrawal would bring the user's ICR < MCR", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });

      await openTrove({ ICR: toBN(dec(11, 17)), extraParams: { from: bob } }); // 110% ICR

      // Bob attempts to withdraws 1 wei, Which would leave him with < 110% ICR.

      try {
        const txBob = await borrowerOperations.withdrawColl(1, bob, bob, { from: bob });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawColl(): reverts if system is in Recovery Mode", async () => {
      // --- SETUP ---

      // A and B open troves at 150% ICR
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } });
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } });

      const TCR = (await th.getTCR(contracts)).toString();
      assert.equal(TCR, "1500000000000000000");

      // --- TEST ---

      // price drops to 1ETH:150USDD, reducing TCR below 150%
      await priceFeed.setPrice("150000000000000000000");

      //Alice tries to withdraw collateral during Recovery Mode
      try {
        const txData = await borrowerOperations.withdrawColl("1", alice, alice, { from: alice });
        assert.isFalse(txData.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawColl(): doesn’t allow a user to completely withdraw all collateral from their Trove (due to gas compensation)", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      const aliceColl = (await troveManager.getEntireDebtAndColl(alice))[1];

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice);
      const status_Before = alice_Trove_Before[3];
      assert.equal(status_Before, 1);
      assert.isTrue(await sortedTroves.contains(alice));

      // Alice attempts to withdraw all collateral
      await assertRevert(
        borrowerOperations.withdrawColl(aliceColl, alice, alice, { from: alice }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("withdrawColl(): leaves the Trove active when the user withdraws less than all the collateral", async () => {
      // Open Trove
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice);
      const status_Before = alice_Trove_Before[3];
      assert.equal(status_Before, 1);
      assert.isTrue(await sortedTroves.contains(alice));

      // Withdraw some collateral
      await borrowerOperations.withdrawColl(dec(100, "finney"), alice, alice, { from: alice });

      // Check Trove is still active
      const alice_Trove_After = await troveManager.Troves(alice);
      const status_After = alice_Trove_After[3];
      assert.equal(status_After, 1);
      assert.isTrue(await sortedTroves.contains(alice));
    });

    it("withdrawColl(): reduces the Trove's collateral by the correct amount", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      const aliceCollBefore = await getTroveEntireColl(alice);

      // Alice withdraws 1 ether
      await borrowerOperations.withdrawColl(dec(1, "ether"), alice, alice, { from: alice });

      // Check 1 ether remaining
      const alice_Trove_After = await troveManager.Troves(alice);
      const aliceCollAfter = await getTroveEntireColl(alice);

      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.sub(toBN(dec(1, "ether")))));
    });

    it("withdrawColl(): reduces ActivePool ETH and raw ether by correct amount", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      const aliceCollBefore = await getTroveEntireColl(alice);

      // check before
      const activePool_ETH_before = await activePool.getColl(collToken.address);
      const activePool_RawEther_before = toBN(await collToken.balanceOf(activePool.address));

      await borrowerOperations.withdrawColl(dec(1, "ether"), alice, alice, { from: alice });

      // check after
      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(activePool_ETH_before.sub(toBN(dec(1, "ether")))));
      assert.isTrue(
        activePool_RawEther_After.eq(activePool_RawEther_before.sub(toBN(dec(1, "ether"))))
      );
    });

    it("withdrawColl(): updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 2 ether
      await openTrove({
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice, value: toBN(dec(5, "ether")) }
      });
      const aliceColl = await getTroveEntireColl(alice);
      assert.isTrue(aliceColl.gt(toBN("0")));

      const alice_Trove_Before = await troveManager.Troves(alice);
      const alice_Stake_Before = alice_Trove_Before[2];
      const totalStakes_Before = await troveManager.totalStakes();

      assert.isTrue(alice_Stake_Before.eq(aliceColl));
      assert.isTrue(totalStakes_Before.eq(aliceColl));

      // Alice withdraws 1 ether
      await borrowerOperations.withdrawColl(dec(1, "ether"), alice, alice, { from: alice });

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice);
      const alice_Stake_After = alice_Trove_After[2];
      const totalStakes_After = await troveManager.totalStakes();

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.sub(toBN(dec(1, "ether")))));
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.sub(toBN(dec(1, "ether")))));
    });

    it("withdrawColl(): sends the correct amount of ETH to the user", async () => {
      await openTrove({
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice, value: dec(2, "ether") }
      });

      const alice_ETHBalance_Before = toBN(web3.utils.toBN(await collToken.balanceOf(alice)));
      await borrowerOperations.withdrawColl(dec(1, "ether"), alice, alice, {
        from: alice,
        gasPrice: 0
      });

      const alice_ETHBalance_After = toBN(web3.utils.toBN(await collToken.balanceOf(alice)));
      const balanceDiff = alice_ETHBalance_After.sub(alice_ETHBalance_Before);

      assert.isTrue(balanceDiff.eq(toBN(dec(1, "ether"))));
    });

    it("withdrawColl(): applies pending rewards and updates user's L_ETH, L_USDDDebt snapshots", async () => {
      // --- SETUP ---
      // Alice adds 15 ether, Bob adds 5 ether, Carol adds 1 ether
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        ICR: toBN(dec(3, 18)),
        extraParams: { from: alice, value: toBN(dec(100, "ether")) }
      });
      await openTrove({
        ICR: toBN(dec(3, 18)),
        extraParams: { from: bob, value: toBN(dec(100, "ether")) }
      });
      await openTrove({
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol, value: toBN(dec(10, "ether")) }
      });

      const aliceCollBefore = await getTroveEntireColl(alice);
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      const bobCollBefore = await getTroveEntireColl(bob);
      const bobDebtBefore = await getTroveEntireDebt(bob);

      // --- TEST ---

      // price drops to 1ETH:100USDD, reducing Carol's ICR below MCR
      await priceFeed.setPrice("100000000000000000000");

      // close Carol's Trove, liquidating her 1 ether and 180USDD.
      await troveManager.liquidate(carol, { from: owner });

      const L_ETH = await troveManager.L_COLL();
      const L_USDDDebt = await troveManager.L_USDDDebt();

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice);
      const alice_ETHrewardSnapshot_Before = alice_rewardSnapshot_Before[0];
      const alice_USDDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1];

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot_Before = bob_rewardSnapshot_Before[0];
      const bob_USDDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1];

      assert.equal(alice_ETHrewardSnapshot_Before, 0);
      assert.equal(alice_USDDDebtRewardSnapshot_Before, 0);
      assert.equal(bob_ETHrewardSnapshot_Before, 0);
      assert.equal(bob_USDDDebtRewardSnapshot_Before, 0);

      // Check A and B have pending rewards
      const pendingCollReward_A = await troveManager.getPendingCollReward(alice);
      const pendingDebtReward_A = await troveManager.getPendingUSDDDebtReward(alice);
      const pendingCollReward_B = await troveManager.getPendingCollReward(bob);
      const pendingDebtReward_B = await troveManager.getPendingUSDDDebtReward(bob);
      for (reward of [
        pendingCollReward_A,
        pendingDebtReward_A,
        pendingCollReward_B,
        pendingDebtReward_B
      ]) {
        assert.isTrue(reward.gt(toBN("0")));
      }

      // Alice and Bob withdraw from their Troves
      const aliceCollWithdrawal = toBN(dec(5, "ether"));
      const bobCollWithdrawal = toBN(dec(1, "ether"));

      await borrowerOperations.withdrawColl(aliceCollWithdrawal, alice, alice, { from: alice });
      await borrowerOperations.withdrawColl(bobCollWithdrawal, bob, bob, { from: bob });

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups.
      const aliceCollAfter = await getTroveEntireColl(alice);
      const aliceDebtAfter = await getTroveEntireDebt(alice);
      const bobCollAfter = await getTroveEntireColl(bob);
      const bobDebtAfter = await getTroveEntireDebt(bob);

      // Check rewards have been applied to troves
      th.assertIsApproximatelyEqual(
        aliceCollAfter,
        aliceCollBefore.add(pendingCollReward_A).sub(aliceCollWithdrawal),
        10000
      );
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(pendingDebtReward_A), 10000);
      th.assertIsApproximatelyEqual(
        bobCollAfter,
        bobCollBefore.add(pendingCollReward_B).sub(bobCollWithdrawal),
        10000
      );
      th.assertIsApproximatelyEqual(bobDebtAfter, bobDebtBefore.add(pendingDebtReward_B), 10000);

      /* After top up, both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_ETH and L_USDDDebt */
      const alice_rewardSnapshot_After = await troveManager.rewardSnapshots(alice);
      const alice_ETHrewardSnapshot_After = alice_rewardSnapshot_After[0];
      const alice_USDDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1];

      const bob_rewardSnapshot_After = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot_After = bob_rewardSnapshot_After[0];
      const bob_USDDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1];

      assert.isAtMost(th.getDifference(alice_ETHrewardSnapshot_After, L_ETH), 100);
      assert.isAtMost(th.getDifference(alice_USDDDebtRewardSnapshot_After, L_USDDDebt), 100);
      assert.isAtMost(th.getDifference(bob_ETHrewardSnapshot_After, L_ETH), 100);
      assert.isAtMost(th.getDifference(bob_USDDDebtRewardSnapshot_After, L_USDDDebt), 100);
    });

    // --- withdrawUSDD() ---

    it("withdrawUSDD(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      assert.isFalse(await troveManager.checkRecoveryMode(price));
      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))));

      const USDDwithdrawal = 1; // withdraw 1 wei USDD

      await assertRevert(
        borrowerOperations.withdrawUSDD(th._100pct, USDDwithdrawal, alice, alice, { from: alice }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("withdrawUSDD(): decays a non-zero base rate", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });

      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const A_USDDBal = await usddToken.balanceOf(A);

      // Artificially set base rate to 5%
      await troveManager.setBaseRate(dec(5, 16));

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), A, A, { from: D });

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), A, A, { from: E });

      const baseRate_3 = await troveManager.baseRate();
      assert.isTrue(baseRate_3.lt(baseRate_2));
    });

    it("withdrawUSDD(): reverts if max fee > 100%", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await assertRevert(
        borrowerOperations.withdrawUSDD(dec(2, 18), dec(1, 18), A, A, { from: A }),
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        borrowerOperations.withdrawUSDD("1000000000000000001", dec(1, 18), A, A, { from: A }),
        "Max fee percentage must be between 0.5% and 100%"
      );
    });

    it("withdrawUSDD(): reverts if max fee < 0.5% in Normal mode", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      await assertRevert(
        borrowerOperations.withdrawUSDD(0, dec(1, 18), A, A, { from: A }),
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        borrowerOperations.withdrawUSDD(1, dec(1, 18), A, A, { from: A }),
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        borrowerOperations.withdrawUSDD("4999999999999999", dec(1, 18), A, A, { from: A }),
        "Max fee percentage must be between 0.5% and 100%"
      );
    });

    it("withdrawUSDD(): reverts if fee exceeds max fee percentage", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(60, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(60, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(70, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(80, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(180, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const totalSupply = await usddToken.totalSupply();

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      let baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));

      // 100%: 1e18,  10%: 1e17,  1%: 1e16,  0.1%: 1e15
      // 5%: 5e16
      // 0.5%: 5e15
      // actual: 0.5%, 5e15

      // USDDFee:                  15000000558793542
      // absolute _fee:            15000000558793542
      // actual feePercentage:      5000000186264514
      // user's _maxFeePercentage: 49999999999999999

      const lessThan5pct = "49999999999999999";
      await assertRevert(
        borrowerOperations.withdrawUSDD(lessThan5pct, dec(3, 18), A, A, { from: A }),
        "Fee exceeded provided maximum"
      );

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));
      // Attempt with maxFee 1%
      await assertRevert(
        borrowerOperations.withdrawUSDD(dec(1, 16), dec(1, 18), A, A, { from: B }),
        "Fee exceeded provided maximum"
      );

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));
      // Attempt with maxFee 3.754%
      await assertRevert(
        borrowerOperations.withdrawUSDD(dec(3754, 13), dec(1, 18), A, A, { from: C }),
        "Fee exceeded provided maximum"
      );

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));
      // Attempt with maxFee 0.5%%
      await assertRevert(
        borrowerOperations.withdrawUSDD(dec(5, 15), dec(1, 18), A, A, { from: D }),
        "Fee exceeded provided maximum"
      );
    });

    it("withdrawUSDD(): succeeds when fee is less than max fee percentage", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(60, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(60, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(70, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(80, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(180, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const totalSupply = await usddToken.totalSupply();

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      let baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.isTrue(baseRate.eq(toBN(dec(5, 16))));

      // Attempt with maxFee > 5%
      const moreThan5pct = "50000000000000001";
      const tx1 = await borrowerOperations.withdrawUSDD(moreThan5pct, dec(1, 18), A, A, { from: A });
      assert.isTrue(tx1.receipt.status);

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));

      // Attempt with maxFee = 5%
      const tx2 = await borrowerOperations.withdrawUSDD(dec(5, 16), dec(1, 18), A, A, { from: B });
      assert.isTrue(tx2.receipt.status);

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));

      // Attempt with maxFee 10%
      const tx3 = await borrowerOperations.withdrawUSDD(dec(1, 17), dec(1, 18), A, A, { from: C });
      assert.isTrue(tx3.receipt.status);

      baseRate = await troveManager.baseRate(); // expect 5% base rate
      assert.equal(baseRate, dec(5, 16));

      // Attempt with maxFee 37.659%
      const tx4 = await borrowerOperations.withdrawUSDD(dec(37659, 13), dec(1, 18), A, A, {
        from: D
      });
      assert.isTrue(tx4.receipt.status);

      // Attempt with maxFee 100%
      const tx5 = await borrowerOperations.withdrawUSDD(dec(1, 18), dec(1, 18), A, A, { from: E });
      assert.isTrue(tx5.receipt.status);
    });

    it("withdrawUSDD(): doesn't change base rate if it is already zero", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });

      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, dec(37, 18), A, A, { from: D });

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate();
      assert.equal(baseRate_2, "0");

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E opens trove
      await borrowerOperations.withdrawUSDD(th._100pct, dec(12, 18), A, A, { from: E });

      const baseRate_3 = await troveManager.baseRate();
      assert.equal(baseRate_3, "0");
    });

    it("withdrawUSDD(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });

      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime();

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider);

      // Borrower C triggers a fee
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), C, C, { from: C });

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1));

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider);

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3);
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60));

      // Borrower C triggers a fee
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), C, C, { from: C });

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1));
    });

    it("withdrawUSDD(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider);

      // Borrower C triggers a fee, before decay interval has passed
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), C, C, { from: C });

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider);

      // Borrower C triggers another fee
      await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), C, C, { from: C });

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));
    });

    it("withdrawUSDD(): borrowing at non-zero base rate sends USDD fee to DEFT staking contract", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT USDD balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, dec(37, 18), C, C, { from: D });

      // Check DEFT USDD balance after has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));
    });

    if (!withProxy) {
      // TODO: use rawLogs instead of logs
      it("withdrawUSDD(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and alice stakes 1 DEFT
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
        await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
        await deftStaking.stake(dec(1, 18), { from: alice });

        await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
        await openTrove({
          extraUSDDAmount: toBN(dec(30, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: A }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(40, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: B }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(50, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: C }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(50, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: D }
        });
        const D_debtBefore = await getTroveEntireDebt(D);

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16));
        await troveManager.setLastFeeOpTimeToNow();

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate();
        assert.isTrue(baseRate_1.gt(toBN("0")));

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider);

        // D withdraws USDD
        const withdrawal_D = toBN(dec(37, 18));
        const withdrawalTx = await borrowerOperations.withdrawUSDD(
          th._100pct,
          toBN(dec(37, 18)),
          D,
          D,
          { from: D }
        );

        const emittedFee = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(withdrawalTx));
        assert.isTrue(emittedFee.gt(toBN("0")));

        const newDebt = (await troveManager.Troves(D))[0];

        // Check debt on Trove struct equals initial debt + withdrawal + emitted fee
        th.assertIsApproximatelyEqual(
          newDebt,
          D_debtBefore.add(withdrawal_D).add(emittedFee),
          10000
        );
      });
    }

    it("withdrawUSDD(): Borrowing at non-zero base rate increases the DEFT staking contract USDD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT contract USDD fees-per-unit-staked is zero
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.equal(F_USDD_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, toBN(dec(37, 18)), D, D, { from: D });

      // Check DEFT contract USDD fees-per-unit-staked has increased
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt(F_USDD_Before));
    });

    it("withdrawUSDD(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT Staking contract balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      const D_USDDBalanceBefore = await usddToken.balanceOf(D);

      // D withdraws USDD
      const D_USDDRequest = toBN(dec(37, 18));
      await borrowerOperations.withdrawUSDD(th._100pct, D_USDDRequest, D, D, { from: D });

      // Check DEFT staking USDD balance has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));

      // Check D's USDD balance now equals their initial balance plus request USDD
      const D_USDDBalanceAfter = await usddToken.balanceOf(D);
      assert.isTrue(D_USDDBalanceAfter.eq(D_USDDBalanceBefore.add(D_USDDRequest)));
    });

    it("withdrawUSDD(): Borrowing at zero base rate changes USDD fees-per-unit-staked", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // A artificially receives DEFT, then stakes it
      await deftToken.mint(A, dec(100, 18));
      await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
      await deftStaking.stake(dec(100, 18), { from: A });

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // Check DEFT USDD balance before == 0
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.equal(F_USDD_Before, "0");

      // D withdraws USDD
      await borrowerOperations.withdrawUSDD(th._100pct, dec(37, 18), D, D, { from: D });

      // Check DEFT USDD balance after > 0
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt("0"));
    });

    it("withdrawUSDD(): Borrowing at zero base rate sends debt request to user", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      const D_USDDBalanceBefore = await usddToken.balanceOf(D);

      // D withdraws USDD
      const D_USDDRequest = toBN(dec(37, 18));
      await borrowerOperations.withdrawUSDD(th._100pct, dec(37, 18), D, D, { from: D });

      // Check D's USDD balance now equals their requested USDD
      const D_USDDBalanceAfter = await usddToken.balanceOf(D);

      // Check D's trove debt == D's USDD balance + liquidation reserve
      assert.isTrue(D_USDDBalanceAfter.eq(D_USDDBalanceBefore.add(D_USDDRequest)));
    });

    it("withdrawUSDD(): reverts when calling address does not have active trove", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });

      // Bob successfully withdraws USDD
      const txBob = await borrowerOperations.withdrawUSDD(th._100pct, dec(100, 18), bob, bob, {
        from: bob
      });
      assert.isTrue(txBob.receipt.status);

      // Carol with no active trove attempts to withdraw USDD
      try {
        const txCarol = await borrowerOperations.withdrawUSDD(
          th._100pct,
          dec(100, 18),
          carol,
          carol,
          { from: carol }
        );
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): reverts when requested withdrawal amount is zero USDD", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });

      // Bob successfully withdraws 1e-18 USDD
      const txBob = await borrowerOperations.withdrawUSDD(th._100pct, 1, bob, bob, { from: bob });
      assert.isTrue(txBob.receipt.status);

      // Alice attempts to withdraw 0 USDD
      try {
        const txAlice = await borrowerOperations.withdrawUSDD(th._100pct, 0, alice, alice, {
          from: alice
        });
        assert.isFalse(txAlice.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): reverts when system is in Recovery Mode", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } });

      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Withdrawal possible when recoveryMode == false
      const txAlice = await borrowerOperations.withdrawUSDD(th._100pct, dec(100, 18), alice, alice, {
        from: alice
      });
      assert.isTrue(txAlice.receipt.status);

      await priceFeed.setPrice("50000000000000000000");

      assert.isTrue(await th.checkRecoveryMode(contracts));

      //Check USDD withdrawal impossible when recoveryMode == true
      try {
        const txBob = await borrowerOperations.withdrawUSDD(th._100pct, 1, bob, bob, { from: bob });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): reverts when withdrawal would bring the trove's ICR < MCR", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(11, 17)), extraParams: { from: bob } });

      // Bob tries to withdraw USDD that would bring his ICR < MCR
      try {
        const txBob = await borrowerOperations.withdrawUSDD(th._100pct, 1, bob, bob, { from: bob });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): reverts when a withdrawal would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      // Alice and Bob creates troves with 150% ICR.  System TCR = 150%.
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } });

      var TCR = (await th.getTCR(contracts)).toString();
      assert.equal(TCR, "1500000000000000000");

      // Bob attempts to withdraw 1 USDD.
      // System TCR would be: ((3+3) * 100 ) / (200+201) = 600/401 = 149.62%, i.e. below CCR of 150%.
      try {
        const txBob = await borrowerOperations.withdrawUSDD(th._100pct, dec(1, 18), bob, bob, {
          from: bob
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): reverts if system is in Recovery Mode", async () => {
      // --- SETUP ---
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } });

      // --- TEST ---

      // price drops to 1ETH:150USDD, reducing TCR below 150%
      await priceFeed.setPrice("150000000000000000000");
      assert.isTrue((await th.getTCR(contracts)).lt(toBN(dec(15, 17))));

      try {
        const txData = await borrowerOperations.withdrawUSDD(th._100pct, "200", alice, alice, {
          from: alice
        });
        assert.isFalse(txData.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("withdrawUSDD(): increases the Trove's USDD debt by the correct amount", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

      // check before
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN(0)));

      await borrowerOperations.withdrawUSDD(
        th._100pct,
        await getNetBorrowingAmount(100),
        alice,
        alice,
        { from: alice }
      );

      // check after
      const aliceDebtAfter = await getTroveEntireDebt(alice);
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(toBN(100)));
    });

    it("withdrawUSDD(): increases USDD debt in ActivePool by correct amount", async () => {
      await openTrove({
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice, value: toBN(dec(100, "ether")) }
      });

      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN(0)));

      // check before
      const activePool_USDD_Before = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDD_Before.eq(aliceDebtBefore));

      await borrowerOperations.withdrawUSDD(
        th._100pct,
        await getNetBorrowingAmount(dec(10000, 18)),
        alice,
        alice,
        { from: alice }
      );

      // check after
      const activePool_USDD_After = await activePool.getUSDDDebt();
      th.assertIsApproximatelyEqual(
        activePool_USDD_After,
        activePool_USDD_Before.add(toBN(dec(10000, 18)))
      );
    });

    it("withdrawUSDD(): increases user USDDToken balance by correct amount", async () => {
      await openTrove({ extraParams: { value: toBN(dec(100, "ether")), from: alice } });

      // check before
      const alice_USDDTokenBalance_Before = await usddToken.balanceOf(alice);
      assert.isTrue(alice_USDDTokenBalance_Before.gt(toBN("0")));

      await borrowerOperations.withdrawUSDD(th._100pct, dec(10000, 18), alice, alice, {
        from: alice
      });

      // check after
      const alice_USDDTokenBalance_After = await usddToken.balanceOf(alice);
      assert.isTrue(
        alice_USDDTokenBalance_After.eq(alice_USDDTokenBalance_Before.add(toBN(dec(10000, 18))))
      );
    });

    // --- repayUSDD() ---
    it("repayUSDD(): reverts when repayment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      assert.isFalse(await troveManager.checkRecoveryMode(price));
      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))));

      const USDDRepayment = 1; // 1 wei repayment

      await assertRevert(
        borrowerOperations.repayUSDD(USDDRepayment, alice, alice, { from: alice }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("repayUSDD(): Succeeds when it would leave trove with net debt >= minimum net debt", async () => {
      // Make the USDD request 2 wei above min net debt to correct for floor division, and make net debt = min net debt + 1 wei
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN("2"))),
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A,
          value: toBN(dec(100, 30))
        }
      });

      const repayTxA = await borrowerOperations.repayUSDD(1, A, A, { from: A });
      assert.isTrue(repayTxA.receipt.status);

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20, 25)),
        upperHint: B,
        lowerHint: B,
        extraParams: {
          from: B,
          value: toBN(dec(100, 30))
        }
      });

      const repayTxB = await borrowerOperations.repayUSDD(dec(19, 25), B, B, { from: B });
      assert.isTrue(repayTxB.receipt.status);
    });

    it("repayUSDD(): reverts when it would leave trove with net debt < minimum net debt", async () => {
      // Make the USDD request 2 wei above min net debt to correct for floor division, and make net debt = min net debt + 1 wei
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN("2"))),
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A,
          value: toBN(dec(100, 30))
        }
      });

      const repayTxAPromise = borrowerOperations.repayUSDD(2, A, A, { from: A });
      await assertRevert(
        repayTxAPromise,
        "BorrowerOps: Trove's net debt must be greater than minimum"
      );
    });

    it("repayUSDD(): reverts when calling address does not have active trove", async () => {
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
      // Bob successfully repays some USDD
      const txBob = await borrowerOperations.repayUSDD(dec(10, 18), bob, bob, { from: bob });
      assert.isTrue(txBob.receipt.status);

      // Carol with no active trove attempts to repayUSDD
      try {
        const txCarol = await borrowerOperations.repayUSDD(dec(10, 18), carol, carol, {
          from: carol
        });
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("repayUSDD(): reverts when attempted repayment is > the debt of the trove", async () => {
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
      const aliceDebt = await getTroveEntireDebt(alice);

      // Bob successfully repays some USDD
      const txBob = await borrowerOperations.repayUSDD(dec(10, 18), bob, bob, { from: bob });
      assert.isTrue(txBob.receipt.status);

      // Alice attempts to repay more than her debt
      try {
        const txAlice = await borrowerOperations.repayUSDD(
          aliceDebt.add(toBN(dec(1, 18))),
          alice,
          alice,
          { from: alice }
        );
        assert.isFalse(txAlice.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    //repayUSDD: reduces USDD debt in Trove
    it("repayUSDD(): reduces the Trove's USDD debt by the correct amount", async () => {
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
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN("0")));

      await borrowerOperations.repayUSDD(aliceDebtBefore.div(toBN(10)), alice, alice, {
        from: alice
      }); // Repays 1/10 her debt

      const aliceDebtAfter = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtAfter.gt(toBN("0")));

      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10))); // check 9/10 debt remaining
    });

    it("repayUSDD(): decreases USDD debt in ActivePool by correct amount", async () => {
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
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN("0")));

      // Check before
      const activePool_USDD_Before = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDD_Before.gt(toBN("0")));

      await borrowerOperations.repayUSDD(aliceDebtBefore.div(toBN(10)), alice, alice, {
        from: alice
      }); // Repays 1/10 her debt

      // check after
      const activePool_USDD_After = await activePool.getUSDDDebt();
      th.assertIsApproximatelyEqual(
        activePool_USDD_After,
        activePool_USDD_Before.sub(aliceDebtBefore.div(toBN(10)))
      );
    });

    it("repayUSDD(): decreases user USDDToken balance by correct amount", async () => {
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
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN("0")));

      // check before
      const alice_USDDTokenBalance_Before = await usddToken.balanceOf(alice);
      assert.isTrue(alice_USDDTokenBalance_Before.gt(toBN("0")));

      await borrowerOperations.repayUSDD(aliceDebtBefore.div(toBN(10)), alice, alice, {
        from: alice
      }); // Repays 1/10 her debt

      // check after
      const alice_USDDTokenBalance_After = await usddToken.balanceOf(alice);
      th.assertIsApproximatelyEqual(
        alice_USDDTokenBalance_After,
        alice_USDDTokenBalance_Before.sub(aliceDebtBefore.div(toBN(10)))
      );
    });

    it("repayUSDD(): can repay debt in Recovery Mode", async () => {
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
      const aliceDebtBefore = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebtBefore.gt(toBN("0")));

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice("105000000000000000000");

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const tx = await borrowerOperations.repayUSDD(aliceDebtBefore.div(toBN(10)), alice, alice, {
        from: alice
      });
      assert.isTrue(tx.receipt.status);

      // Check Alice's debt: 110 (initial) - 50 (repaid)
      const aliceDebtAfter = await getTroveEntireDebt(alice);
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10)));
    });

    it("repayUSDD(): Reverts if borrower has insufficient USDD balance to cover his debt repayment", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      const bobBalBefore = await usddToken.balanceOf(B);
      assert.isTrue(bobBalBefore.gt(toBN("0")));

      // Bob transfers all but 5 of his USDD to Carol
      await usddToken.transfer(C, bobBalBefore.sub(toBN(dec(5, 18))), { from: B });

      //Confirm B's USDD balance has decreased to 5 USDD
      const bobBalAfter = await usddToken.balanceOf(B);

      assert.isTrue(bobBalAfter.eq(toBN(dec(5, 18))));

      // Bob tries to repay 6 USDD
      const repayUSDDPromise_B = borrowerOperations.repayUSDD(toBN(dec(6, 18)), B, B, { from: B });

      await assertRevert(repayUSDDPromise_B, "Caller doesnt have enough USDD to make repayment");
    });

    // --- adjustTrove() ---

    it("adjustTrove(): reverts when adjustment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      assert.isFalse(await troveManager.checkRecoveryMode(price));
      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))));

      const USDDRepayment = 1; // 1 wei repayment
      const collTopUp = 1;

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(collTopUp),
          collWithdrawal: 0,
          debtChange: USDDRepayment,
          isDebtIncrease: false,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("adjustTrove(): reverts if max fee < 0.5% in Normal mode", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });

      await assertRevert(
        adjustTrove({
          maxFee: 0,
          collDeposited: toBN(dec(2, 16)),
          collWithdrawal: 0,
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: A
          }
        }),
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        adjustTrove({
          maxFee: 1,
          collDeposited: toBN(dec(2, 16)),
          collWithdrawal: 0,
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: A
          }
        }),
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        adjustTrove({
          maxFee: toBN("4999999999999999"),
          collDeposited: toBN(dec(2, 16)),
          collWithdrawal: 0,
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: A
          }
        }),
        "Max fee percentage must be between 0.5% and 100%"
      );
    });

    it("adjustTrove(): allows max fee < 0.5% in Recovery mode", async () => {
      await openTrove({
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });

      await priceFeed.setPrice(dec(120, 18));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await adjustTrove({
        maxFee: 0,
        collDeposited: toBN(dec(300, 18)),
        collWithdrawal: 0,
        debtChange: dec(1, 9),
        isDebtIncrease: true,
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A
        }
      });
      await priceFeed.setPrice(dec(1, 18));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await adjustTrove({
        maxFee: 1,
        collDeposited: toBN(dec(30000, 18)),
        collWithdrawal: 0,
        debtChange: dec(1, 9),
        isDebtIncrease: true,
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A
        }
      });
      await priceFeed.setPrice(dec(1, 16));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await adjustTrove({
        maxFee: toBN("4999999999999999"),
        collDeposited: toBN(dec(3000000, 18)),
        collWithdrawal: 0,
        debtChange: dec(1, 9),
        isDebtIncrease: true,
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A
        }
      });
    });

    it("adjustTrove(): decays a non-zero base rate", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 18),
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 15),
        isDebtIncrease: true,
        upperHint: E,
        lowerHint: E,
        extraParams: {
          from: D
        }
      });

      const baseRate_3 = await troveManager.baseRate();
      assert.isTrue(baseRate_3.lt(baseRate_2));
    });

    it("adjustTrove(): doesn't decay a non-zero base rate when user issues 0 debt", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove with 0 debt

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: 0,
        isDebtIncrease: false,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check baseRate has not decreased
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.eq(baseRate_1));
    });

    it("adjustTrove(): doesn't change base rate if it is already zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 18),
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate();
      assert.equal(baseRate_2, "0");

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 15),
        isDebtIncrease: true,
        upperHint: E,
        lowerHint: E,
        extraParams: {
          from: D
        }
      });

      const baseRate_3 = await troveManager.baseRate();
      assert.equal(baseRate_3, "0");
    });

    it("adjustTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime();

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider);

      // Borrower C triggers a fee

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(1, 18),
        isDebtIncrease: true,
        upperHint: C,
        lowerHint: C,
        extraParams: {
          from: C
        }
      });

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1));

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider);

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3);
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60));

      // Borrower C triggers a fee

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(1, 18),
        isDebtIncrease: true,
        upperHint: C,
        lowerHint: C,
        extraParams: {
          from: C
        }
      });

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1));
    });

    it("adjustTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // Borrower C triggers a fee, before decay interval of 1 minute has passed

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(1, 18),
        isDebtIncrease: true,
        upperHint: C,
        lowerHint: C,
        extraParams: {
          from: C
        }
      });

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider);

      // Borrower C triggers another fee

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(1, 18),
        isDebtIncrease: true,
        upperHint: C,
        lowerHint: C,
        extraParams: {
          from: C
        }
      });

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));
    });

    it("adjustTrove(): borrowing at non-zero base rate sends USDD fee to DEFT staking contract", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT USDD balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove
      await openTrove({
        extraUSDDAmount: toBN(dec(37, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check DEFT USDD balance after has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));
    });

    if (!withProxy) {
      // TODO: use rawLogs instead of logs
      it("adjustTrove(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and alice stakes 1 DEFT
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
        await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
        await deftStaking.stake(dec(1, 18), { from: alice });

        await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
        await openTrove({
          extraUSDDAmount: toBN(dec(30, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: A }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(40, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: B }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(50, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: C }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(50, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: D }
        });
        const D_debtBefore = await getTroveEntireDebt(D);

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16));
        await troveManager.setLastFeeOpTimeToNow();

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate();
        assert.isTrue(baseRate_1.gt(toBN("0")));

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider);

        const withdrawal_D = toBN(dec(37, 18));

        // D withdraws USDD

        const adjustmentTx = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: 0,
          debtChange: withdrawal_D,
          isDebtIncrease: true,
          upperHint: D,
          lowerHint: D,
          extraParams: {
            from: D
          }
        });

        const emittedFee = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(adjustmentTx));
        assert.isTrue(emittedFee.gt(toBN("0")));

        const D_newDebt = (await troveManager.Troves(D))[0];

        // Check debt on Trove struct equals initila debt plus drawn debt plus emitted fee
        assert.isTrue(D_newDebt.eq(D_debtBefore.add(withdrawal_D).add(emittedFee)));
      });
    }

    it("adjustTrove(): Borrowing at non-zero base rate increases the DEFT staking contract USDD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT contract USDD fees-per-unit-staked is zero
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.equal(F_USDD_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 18),
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check DEFT contract USDD fees-per-unit-staked has increased
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt(F_USDD_Before));
    });

    it("adjustTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT Staking contract balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      const D_USDDBalanceBefore = await usddToken.balanceOf(D);

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D adjusts trove
      const USDDRequest_D = toBN(dec(40, 18));

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: USDDRequest_D,
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check DEFT staking USDD balance has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));

      // Check D's USDD balance has increased by their requested USDD
      const D_USDDBalanceAfter = await usddToken.balanceOf(D);
      assert.isTrue(D_USDDBalanceAfter.eq(D_USDDBalanceBefore.add(USDDRequest_D)));
    });

    it("adjustTrove(): Borrowing at zero base rate changes USDD balance of DEFT staking contract", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } });
      await openTrove({
        extraUSDDAmount: toBN(dec(30, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(50, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // Check staking USDD balance before > 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_Before.gt(toBN("0")));

      // D adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 18),
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check staking USDD balance after > staking balance before
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));
    });

    it("adjustTrove(): Borrowing at zero base rate changes DEFT staking contract USDD fees-per-unit-staked", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: toBN(dec(100, "ether")) }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // A artificially receives DEFT, then stakes it
      await deftToken.mint(A, dec(100, 18));
      await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
      await deftStaking.stake(dec(100, 18), { from: A });

      // Check staking USDD balance before == 0
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_Before.eq(toBN("0")));

      // D adjusts trove

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(37, 18),
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check staking USDD balance increases
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt(F_USDD_Before));
    });

    it("adjustTrove(): Borrowing at zero base rate sends total requested USDD to the user", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale, value: toBN(dec(100, "ether")) }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      const D_USDDBalBefore = await usddToken.balanceOf(D);
      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      const DUSDBalanceBefore = await usddToken.balanceOf(D);

      // D adjusts trove
      const USDDRequest_D = toBN(dec(40, 18));

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: USDDRequest_D,
        isDebtIncrease: true,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D
        }
      });

      // Check D's USDD balance increased by their requested USDD
      const USDDBalanceAfter = await usddToken.balanceOf(D);
      assert.isTrue(USDDBalanceAfter.eq(D_USDDBalBefore.add(USDDRequest_D)));
    });

    it("adjustTrove(): reverts when calling address has no active trove", async () => {
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

      // Alice coll and debt increase(+1 ETH, +50USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      try {
        const txCarol = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(dec(1, "ether")),
          collWithdrawal: 0,
          debtChange: dec(50, 18),
          isDebtIncrease: true,
          upperHint: carol,
          lowerHint: carol,
          extraParams: {
            from: carol
          }
        });
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("adjustTrove(): reverts in Recovery Mode when the adjustment would reduce the TCR", async () => {
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

      assert.isFalse(await th.checkRecoveryMode(contracts));

      const txAlice = await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      assert.isTrue(txAlice.receipt.status);

      await priceFeed.setPrice(dec(120, 18)); // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts));

      try {
        // collateral withdrawal should also fail

        const txAlice = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: toBN(dec(1, "ether")),
          debtChange: 0,
          isDebtIncrease: false,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        });
        assert.isFalse(txAlice.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }

      try {
        // debt increase should fail

        const txBob = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: 0,
          debtChange: dec(50, 18),
          isDebtIncrease: true,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }

      try {
        // debt increase that's also a collateral increase should also fail, if ICR will be worse off
        const txBob = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(dec(1, "ether")),
          collWithdrawal: 0,
          debtChange: dec(111, 18),
          isDebtIncrease: true,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("adjustTrove(): collateral withdrawal reverts in Recovery Mode", async () => {
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

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(120, 18)); // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Alice attempts an adjustment that repays half her debt BUT withdraws 1 wei collateral, and fails
      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: 1,
          debtChange: dec(5000, 18),
          isDebtIncrease: false,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOps: Collateral withdrawal not permitted Recovery Mode"
      );
    });

    it("adjustTrove(): debt increase that would leave ICR < 150% reverts in Recovery Mode", async () => {
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
      const CCR = await troveManager.CCR();

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(120, 18)); // trigger drop in ETH price
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const ICR_A = await troveManager.getCurrentICR(alice, price);

      const aliceDebt = await getTroveEntireDebt(alice);
      const aliceColl = await getTroveEntireColl(alice);
      const debtIncrease = toBN(dec(50, 18));
      const collIncrease = toBN(dec(1, "ether"));

      // Check the new ICR would be an improvement, but less than the CCR (150%)
      const newICR = await troveManager.computeICR(
        aliceColl.add(collIncrease),
        aliceDebt.add(debtIncrease),
        price
      );

      assert.isTrue(newICR.gt(ICR_A) && newICR.lt(CCR));

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: collIncrease,
          collWithdrawal: 0,
          debtChange: debtIncrease,
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOps: Operation must leave trove with ICR >= CCR"
      );
    });

    it("adjustTrove(): debt increase that would reduce the ICR reverts in Recovery Mode", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(3, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      const CCR = await troveManager.CCR();

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(105, 18)); // trigger drop in ETH price
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      //--- Alice with ICR > 150% tries to reduce her ICR ---

      const ICR_A = await troveManager.getCurrentICR(alice, price);

      // Check Alice's initial ICR is above 150%
      assert.isTrue(ICR_A.gt(CCR));

      const aliceDebt = await getTroveEntireDebt(alice);
      const aliceColl = await getTroveEntireColl(alice);
      const aliceDebtIncrease = toBN(dec(150, 18));
      const aliceCollIncrease = toBN(dec(1, "ether"));

      const newICR_A = await troveManager.computeICR(
        aliceColl.add(aliceCollIncrease),
        aliceDebt.add(aliceDebtIncrease),
        price
      );

      // Check Alice's new ICR would reduce but still be greater than 150%
      assert.isTrue(newICR_A.lt(ICR_A) && newICR_A.gt(CCR));

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: aliceCollIncrease,
          collWithdrawal: 0,
          debtChange: aliceDebtIncrease,
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode"
      );

      //--- Bob with ICR < 150% tries to reduce his ICR ---

      const ICR_B = await troveManager.getCurrentICR(bob, price);

      // Check Bob's initial ICR is below 150%
      assert.isTrue(ICR_B.lt(CCR));

      const bobDebt = await getTroveEntireDebt(bob);
      const bobColl = await getTroveEntireColl(bob);
      const bobDebtIncrease = toBN(dec(450, 18));
      const bobCollIncrease = toBN(dec(1, "ether"));

      const newICR_B = await troveManager.computeICR(
        bobColl.add(bobCollIncrease),
        bobDebt.add(bobDebtIncrease),
        price
      );

      // Check Bob's new ICR would reduce
      assert.isTrue(newICR_B.lt(ICR_B));

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: bobCollIncrease,
          collWithdrawal: 0,
          debtChange: bobDebtIncrease,
          isDebtIncrease: true,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        }),
        " BorrowerOps: Operation must leave trove with ICR >= CCR"
      );
    });

    it("adjustTrove(): A trove with ICR < CCR in Recovery Mode can adjust their trove to ICR > CCR", async () => {
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
      const CCR = await troveManager.CCR();

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(100, 18)); // trigger drop in ETH price
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const ICR_A = await troveManager.getCurrentICR(alice, price);
      // Check initial ICR is below 150%
      assert.isTrue(ICR_A.lt(CCR));

      const aliceDebt = await getTroveEntireDebt(alice);
      const aliceColl = await getTroveEntireColl(alice);
      const debtIncrease = toBN(dec(5000, 18));
      const collIncrease = toBN(dec(150, "ether"));

      const newICR = await troveManager.computeICR(
        aliceColl.add(collIncrease),
        aliceDebt.add(debtIncrease),
        price
      );

      // Check new ICR would be > 150%
      assert.isTrue(newICR.gt(CCR));

      const tx = await adjustTrove({
        maxFee: th._100pct,
        collDeposited: collIncrease,
        collWithdrawal: 0,
        debtChange: debtIncrease,
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      assert.isTrue(tx.receipt.status);

      const actualNewICR = await troveManager.getCurrentICR(alice, price);
      assert.isTrue(actualNewICR.gt(CCR));
    });

    it("adjustTrove(): A trove with ICR > CCR in Recovery Mode can improve their ICR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(3, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      const CCR = await troveManager.CCR();

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(105, 18)); // trigger drop in ETH price
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const initialICR = await troveManager.getCurrentICR(alice, price);
      // Check initial ICR is above 150%
      assert.isTrue(initialICR.gt(CCR));

      const aliceDebt = await getTroveEntireDebt(alice);
      const aliceColl = await getTroveEntireColl(alice);
      const debtIncrease = toBN(dec(5000, 18));
      const collIncrease = toBN(dec(150, "ether"));

      const newICR = await troveManager.computeICR(
        aliceColl.add(collIncrease),
        aliceDebt.add(debtIncrease),
        price
      );

      // Check new ICR would be > old ICR
      assert.isTrue(newICR.gt(initialICR));

      const tx = await adjustTrove({
        maxFee: th._100pct,
        collDeposited: collIncrease,
        collWithdrawal: 0,
        debtChange: debtIncrease,
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });
      assert.isTrue(tx.receipt.status);

      const actualNewICR = await troveManager.getCurrentICR(alice, price);
      assert.isTrue(actualNewICR.gt(initialICR));
    });

    it("adjustTrove(): debt increase in Recovery Mode charges no fee", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(200000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(120, 18)); // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // B stakes DEFT
      await deftToken.mint(bob, dec(100, 18));
      await deftToken.approve(deftStaking.address, dec(100, 18), { from: bob });
      await deftStaking.stake(dec(100, 18), { from: bob });

      const deftStakingUSDDBalanceBefore = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStakingUSDDBalanceBefore.gt(toBN("0")));

      const txAlice = await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(100, "ether")),
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      assert.isTrue(txAlice.receipt.status);

      // Check emitted fee = 0
      const emittedFee = toBN(
        await th.getEventArgByName(txAlice, "USDDBorrowingFeePaid", "_USDDFee")
      );
      assert.isTrue(emittedFee.eq(toBN("0")));

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Check no fee was sent to staking contract
      const deftStakingUSDDBalanceAfter = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStakingUSDDBalanceAfter.toString(), deftStakingUSDDBalanceBefore.toString());
    });

    it("adjustTrove(): reverts when change would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18));

      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } });

      // Check TCR and Recovery Mode
      const TCR = (await th.getTCR(contracts)).toString();
      assert.equal(TCR, "1500000000000000000");
      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Bob attempts an operation that would bring the TCR below the CCR
      try {
        const txBob = await adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: 0,
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("adjustTrove(): reverts when USDD repaid is > debt of the trove", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      const bobOpenTx = (await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })).tx;

      const bobDebt = await getTroveEntireDebt(bob);
      assert.isTrue(bobDebt.gt(toBN("0")));

      const bobFee = toBN(await th.getEventArgByIndex(bobOpenTx, "USDDBorrowingFeePaid", 1));
      assert.isTrue(bobFee.gt(toBN("0")));

      // Alice transfers USDD to bob to compensate borrowing fees
      await usddToken.transfer(bob, bobFee, { from: alice });

      const remainingDebt = (await troveManager.getTroveDebt(bob)).sub(USDD_GAS_COMPENSATION);

      // Bob attempts an adjustment that would repay 1 wei more than his debt
      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(dec(1, "ether")),
          collWithdrawal: 0,
          debtChange: remainingDebt.add(toBN(1)),
          isDebtIncrease: false,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        }),
        "revert"
      );
    });

    it("adjustTrove(): reverts when attempted ETH withdrawal is >= the trove's collateral", async () => {
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } });
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } });

      const carolColl = await getTroveEntireColl(carol);

      // Carol attempts an adjustment that would withdraw 1 wei more than her ETH
      try {
        await adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: carolColl.add(toBN(1)),
          debtChange: 0,
          isDebtIncrease: true,
          upperHint: carol,
          lowerHint: carol,
          extraParams: {
            from: carol
          }
        });
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("adjustTrove(): reverts when change would cause the ICR of the trove to fall below the MCR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(100, 18)),
        extraParams: { from: whale }
      });

      await priceFeed.setPrice(dec(100, 18));

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(11, 17)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(11, 17)),
        extraParams: { from: bob }
      });

      // Bob attempts to increase debt by 100 USDD and 1 ether, i.e. a change that constitutes a 100% ratio of coll:debt.
      // Since his ICR prior is 110%, this change would reduce his ICR below MCR.
      try {
        await adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(dec(1, "ether")),
          collWithdrawal: 0,
          debtChange: dec(100, 18),
          isDebtIncrease: true,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        });
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("adjustTrove(): With 0 coll change, doesnt change borrower's coll or ActivePool coll", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceCollBefore = await getTroveEntireColl(alice);
      const activePoolCollBefore = await activePool.getColl(collToken.address);

      assert.isTrue(aliceCollBefore.gt(toBN("0")));
      assert.isTrue(aliceCollBefore.eq(activePoolCollBefore));

      // Alice adjusts trove. No coll change, and a debt increase (+50USDD)
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const aliceCollAfter = await getTroveEntireColl(alice);
      const activePoolCollAfter = await activePool.getColl(collToken.address);

      assert.isTrue(aliceCollAfter.eq(activePoolCollAfter));
      assert.isTrue(activePoolCollAfter.eq(activePoolCollAfter));
    });

    it("adjustTrove(): With 0 debt change, doesnt change borrower's debt or ActivePool debt", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceDebtBefore = await getTroveEntireDebt(alice);
      const activePoolDebtBefore = await activePool.getUSDDDebt();

      assert.isTrue(aliceDebtBefore.gt(toBN("0")));
      assert.isTrue(aliceDebtBefore.eq(activePoolDebtBefore));

      // Alice adjusts trove. Coll change, no debt change

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: 0,
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const aliceDebtAfter = await getTroveEntireDebt(alice);
      const activePoolDebtAfter = await activePool.getUSDDDebt();

      assert.isTrue(aliceDebtAfter.eq(aliceDebtBefore));
      assert.isTrue(activePoolDebtAfter.eq(activePoolDebtBefore));
    });

    it("adjustTrove(): updates borrower's debt and coll with an increase in both", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const debtBefore = await getTroveEntireDebt(alice);
      const collBefore = await getTroveEntireColl(alice);
      assert.isTrue(debtBefore.gt(toBN("0")));
      assert.isTrue(collBefore.gt(toBN("0")));

      // Alice adjusts trove. Coll and debt increase(+1 ETH, +50USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: await getNetBorrowingAmount(dec(50, 18)),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const debtAfter = await getTroveEntireDebt(alice);
      const collAfter = await getTroveEntireColl(alice);

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(50, 18))), 10000);
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(1, 18))), 10000);
    });

    it("adjustTrove(): updates borrower's debt and coll with a decrease in both", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const debtBefore = await getTroveEntireDebt(alice);
      const collBefore = await getTroveEntireColl(alice);
      assert.isTrue(debtBefore.gt(toBN("0")));
      assert.isTrue(collBefore.gt(toBN("0")));

      // Alice adjusts trove coll and debt decrease (-0.5 ETH, -50USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: dec(500, "finney"),
        debtChange: dec(50, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const debtAfter = await getTroveEntireDebt(alice);
      const collAfter = await getTroveEntireColl(alice);

      assert.isTrue(debtAfter.eq(debtBefore.sub(toBN(dec(50, 18)))));
      assert.isTrue(collAfter.eq(collBefore.sub(toBN(dec(5, 17)))));
    });

    it("adjustTrove(): updates borrower's  debt and coll with coll increase, debt decrease", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const debtBefore = await getTroveEntireDebt(alice);
      const collBefore = await getTroveEntireColl(alice);
      assert.isTrue(debtBefore.gt(toBN("0")));
      assert.isTrue(collBefore.gt(toBN("0")));

      // Alice adjusts trove - coll increase and debt decrease (+0.5 ETH, -50USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(500, "finney")),
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const debtAfter = await getTroveEntireDebt(alice);
      const collAfter = await getTroveEntireColl(alice);

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.sub(toBN(dec(50, 18))), 10000);
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(5, 17))), 10000);
    });

    it("adjustTrove(): updates borrower's debt and coll with coll decrease, debt increase", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const debtBefore = await getTroveEntireDebt(alice);
      const collBefore = await getTroveEntireColl(alice);
      assert.isTrue(debtBefore.gt(toBN("0")));
      assert.isTrue(collBefore.gt(toBN("0")));

      // Alice adjusts trove - coll decrease and debt increase (0.1 ETH, 10USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: dec(1, 17),
        debtChange: await getNetBorrowingAmount(dec(1, 18)),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const debtAfter = await getTroveEntireDebt(alice);
      const collAfter = await getTroveEntireColl(alice);

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(1, 18))), 10000);
      th.assertIsApproximatelyEqual(collAfter, collBefore.sub(toBN(dec(1, 17))), 10000);
    });

    it("adjustTrove(): updates borrower's stake and totalStakes with a coll increase", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const stakeBefore = await troveManager.getTroveStake(alice);
      const totalStakesBefore = await troveManager.totalStakes();
      assert.isTrue(stakeBefore.gt(toBN("0")));
      assert.isTrue(totalStakesBefore.gt(toBN("0")));

      // Alice adjusts trove - coll and debt increase (+1 ETH, +50 USDD)

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(50, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const stakeAfter = await troveManager.getTroveStake(alice);
      const totalStakesAfter = await troveManager.totalStakes();

      assert.isTrue(stakeAfter.eq(stakeBefore.add(toBN(dec(1, 18)))));
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.add(toBN(dec(1, 18)))));
    });

    it("adjustTrove():  updates borrower's stake and totalStakes with a coll decrease", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const stakeBefore = await troveManager.getTroveStake(alice);
      const totalStakesBefore = await troveManager.totalStakes();
      assert.isTrue(stakeBefore.gt(toBN("0")));
      assert.isTrue(totalStakesBefore.gt(toBN("0")));

      // Alice adjusts trove - coll decrease and debt decrease

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: dec(500, "finney"),
        debtChange: dec(50, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const stakeAfter = await troveManager.getTroveStake(alice);
      const totalStakesAfter = await troveManager.totalStakes();

      assert.isTrue(stakeAfter.eq(stakeBefore.sub(toBN(dec(5, 17)))));
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(toBN(dec(5, 17)))));
    });

    it("adjustTrove(): changes USDDToken balance by the requested decrease", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const alice_USDDTokenBalance_Before = await usddToken.balanceOf(alice);
      assert.isTrue(alice_USDDTokenBalance_Before.gt(toBN("0")));

      // Alice adjusts trove - coll decrease and debt decrease

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: dec(100, "finney"),
        debtChange: dec(10, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      // check after
      const alice_USDDTokenBalance_After = await usddToken.balanceOf(alice);
      assert.isTrue(
        alice_USDDTokenBalance_After.eq(alice_USDDTokenBalance_Before.sub(toBN(dec(10, 18))))
      );
    });

    it("adjustTrove(): changes USDDToken balance by the requested increase", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const alice_USDDTokenBalance_Before = await usddToken.balanceOf(alice);
      assert.isTrue(alice_USDDTokenBalance_Before.gt(toBN("0")));

      // Alice adjusts trove - coll increase and debt increase

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(100, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      // check after
      const alice_USDDTokenBalance_After = await usddToken.balanceOf(alice);
      assert.isTrue(
        alice_USDDTokenBalance_After.eq(alice_USDDTokenBalance_Before.add(toBN(dec(100, 18))))
      );
    });

    it("adjustTrove(): Changes the activePool ETH and raw ether balance by the requested decrease", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const activePool_ETH_Before = await activePool.getColl(collToken.address);
      const activePool_RawEther_Before = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_Before.gt(toBN("0")));
      assert.isTrue(activePool_RawEther_Before.gt(toBN("0")));

      // Alice adjusts trove - coll decrease and debt decrease

      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: dec(100, "finney"),
        debtChange: dec(10, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(activePool_ETH_Before.sub(toBN(dec(1, 17)))));
      assert.isTrue(activePool_RawEther_After.eq(activePool_ETH_Before.sub(toBN(dec(1, 17)))));
    });

    it("adjustTrove(): Changes the activePool ETH and raw ether balance by the amount of ETH sent", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const activePool_ETH_Before = await activePool.getColl(collToken.address);
      const activePool_RawEther_Before = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_Before.gt(toBN("0")));
      assert.isTrue(activePool_RawEther_Before.gt(toBN("0")));

      // Alice adjusts trove - coll increase and debt increase
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(100, 18),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(activePool_ETH_Before.add(toBN(dec(1, 18)))));
      assert.isTrue(activePool_RawEther_After.eq(activePool_ETH_Before.add(toBN(dec(1, 18)))));
    });

    it("adjustTrove(): Changes the USDD debt in ActivePool by requested decrease", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const activePool_USDDDebt_Before = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDDDebt_Before.gt(toBN("0")));

      // Alice adjusts trove - coll increase and debt decrease
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: dec(30, 18),
        isDebtIncrease: false,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const activePool_USDDDebt_After = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDDDebt_After.eq(activePool_USDDDebt_Before.sub(toBN(dec(30, 18)))));
    });

    it("adjustTrove(): Changes the USDD debt in ActivePool by requested increase", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const activePool_USDDDebt_Before = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDDDebt_Before.gt(toBN("0")));

      // Alice adjusts trove - coll increase and debt increase
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: toBN(dec(1, "ether")),
        collWithdrawal: 0,
        debtChange: await getNetBorrowingAmount(dec(100, 18)),
        isDebtIncrease: true,
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice
        }
      });

      const activePool_USDDDebt_After = await activePool.getUSDDDebt();

      th.assertIsApproximatelyEqual(
        activePool_USDDDebt_After,
        activePool_USDDDebt_Before.add(toBN(dec(100, 18)))
      );
    });

    it("adjustTrove(): new coll = 0 and new debt = 0 is not allowed, as gas compensation still counts toward ICR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      const aliceColl = await getTroveEntireColl(alice);
      const aliceDebt = await getTroveEntireColl(alice);
      const status_Before = await troveManager.getTroveStatus(alice);
      const isInSortedList_Before = await sortedTroves.contains(alice);

      assert.equal(status_Before, 1); // 1: Active
      assert.isTrue(isInSortedList_Before);

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: aliceColl,
          debtChange: aliceDebt,
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),

        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      );
    });

    it("adjustTrove(): Reverts if requested debt increase and amount is zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: 0,
          debtChange: 0,
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOps: Debt increase requires non-zero debtChange"
      );
    });

    it("adjustTrove(): Reverts if requested coll withdrawal and ether is sent", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: toBN(dec(3, "ether")),
          collWithdrawal: dec(1, "ether"),
          debtChange: dec(100, 18),
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        }),
        "BorrowerOperations: Cannot withdraw and add coll"
      );
    });

    it("adjustTrove(): Reverts if requested coll withdrawal is greater than trove's collateral", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });

      const aliceColl = await getTroveEntireColl(alice);

      // Requested coll withdrawal > coll in the trove
      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: aliceColl.add(toBN(1)),
          debtChange: 0,
          isDebtIncrease: false,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice
          }
        })
      );
      await assertRevert(
        adjustTrove({
          maxFee: th._100pct,
          collDeposited: 0,
          collWithdrawal: aliceColl.add(toBN(dec(37, "ether"))),
          debtChange: 0,
          isDebtIncrease: false,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob
          }
        })
      );
    });

    it("adjustTrove(): Reverts if borrower has insufficient USDD balance to cover his debt repayment", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: B }
      });
      const bobDebt = await getTroveEntireDebt(B);

      // Bob transfers some USDD to carol
      await usddToken.transfer(C, dec(10, 18), { from: B });

      //Confirm B's USDD balance is less than 50 USDD
      const B_USDDBal = await usddToken.balanceOf(B);
      assert.isTrue(B_USDDBal.lt(bobDebt));

      const repayUSDDPromise_B = adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: bobDebt,
        isDebtIncrease: false,
        upperHint: B,
        lowerHint: B,
        extraParams: {
          from: B
        }
      });

      // B attempts to repay all his debt
      await assertRevert(repayUSDDPromise_B, "revert");
    });

    // --- Internal _adjustTrove() ---

    if (!withProxy) {
      // no need to test this with proxies
      it("Internal _adjustTrove(): reverts when op is a withdrawal and _borrower param is not the msg.sender", async () => {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(10, 18)),
          extraParams: { from: whale }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(10, 18)),
          extraParams: { from: bob }
        });

        const txPromise_A = adjustTrove({
          borrower: alice,
          maxFee: 0,
          collDeposited: 0,
          collWithdrawal: dec(1, 18),
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: bob
          }
        });

        await assertRevert(txPromise_A, "BorrowerOps: Caller must be the borrower for a withdrawal");

        const txPromise_B = adjustTrove({
          borrower: bob,
          maxFee: 0,
          collDeposited: 0,
          collWithdrawal: dec(1, 18),
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: owner
          }
        });
        await assertRevert(txPromise_B, "BorrowerOps: Caller must be the borrower for a withdrawal");

        const txPromise_C = adjustTrove({
          borrower: carol,
          maxFee: 0,
          collDeposited: 0,
          collWithdrawal: dec(1, 18),
          debtChange: dec(1, 18),
          isDebtIncrease: true,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: bob
          }
        });
        await assertRevert(txPromise_C, "BorrowerOps: Caller must be the borrower for a withdrawal");
      });
    }

    // --- closeTrove() ---

    it("closeTrove(): reverts when it would lower the TCR below CCR", async () => {
      await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: alice } });
      await openTrove({
        ICR: toBN(dec(120, 16)),
        extraUSDDAmount: toBN(dec(300, 18)),
        extraParams: { from: bob }
      });

      const price = await priceFeed.getPrice();

      // to compensate borrowing fees
      await usddToken.transfer(alice, dec(300, 18), { from: bob });

      assert.isFalse(await troveManager.checkRecoveryMode(price));

      await assertRevert(
        borrowerOperations.closeTrove({ from: alice }),
        "BorrowerOps: An operation that would result in TCR < CCR is not permitted"
      );
    });

    it("closeTrove(): reverts when calling address does not have active trove", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: bob }
      });

      // Carol with no active trove attempts to close her trove
      try {
        const txCarol = await borrowerOperations.closeTrove({ from: carol });
        assert.isFalse(txCarol.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("closeTrove(): reverts when system is in Recovery Mode", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // Alice transfers her USDD to Bob and Carol so they can cover fees
      const aliceBal = await usddToken.balanceOf(alice);
      await usddToken.transfer(bob, aliceBal.div(toBN(2)), { from: alice });
      await usddToken.transfer(carol, aliceBal.div(toBN(2)), { from: alice });

      // check Recovery Mode
      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Bob successfully closes his trove
      const txBob = await borrowerOperations.closeTrove({ from: bob });
      assert.isTrue(txBob.receipt.status);

      await priceFeed.setPrice(dec(100, 18));

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Carol attempts to close her trove during Recovery Mode
      await assertRevert(
        borrowerOperations.closeTrove({ from: carol }),
        "BorrowerOps: Operation not permitted during Recovery Mode"
      );
    });

    it("closeTrove(): reverts when trove is the only one in the system", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(100000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      // Artificially mint to Alice so she has enough to close her trove
      await usddToken.unprotectedMint(alice, dec(100000, 18));

      // Check she has more USDD than her trove debt
      const aliceBal = await usddToken.balanceOf(alice);
      const aliceDebt = await getTroveEntireDebt(alice);
      assert.isTrue(aliceBal.gt(aliceDebt));

      // check Recovery Mode
      assert.isFalse(await th.checkRecoveryMode(contracts));

      await priceFeed.setPrice(dec(1, 18));

      // Check Recovery Mode
      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Alice attempts to close her trove
      await assertRevert(
        borrowerOperations.closeTrove({ from: alice }),
        "BorrowerOps: Operation not permitted during Recovery Mode"
      );
    });

    it("closeTrove(): reduces a Trove's collateral to zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceCollBefore = await getTroveEntireColl(alice);
      const dennisUSDD = await usddToken.balanceOf(dennis);
      assert.isTrue(aliceCollBefore.gt(toBN("0")));
      assert.isTrue(dennisUSDD.gt(toBN("0")));

      // To compensate borrowing fees
      await usddToken.transfer(alice, dennisUSDD.div(toBN(2)), { from: dennis });

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice });

      const aliceCollAfter = await getTroveEntireColl(alice);
      assert.equal(aliceCollAfter, "0");
    });

    it("closeTrove(): reduces a Trove's debt to zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceDebtBefore = await getTroveEntireColl(alice);
      const dennisUSDD = await usddToken.balanceOf(dennis);
      assert.isTrue(aliceDebtBefore.gt(toBN("0")));
      assert.isTrue(dennisUSDD.gt(toBN("0")));

      // To compensate borrowing fees
      await usddToken.transfer(alice, dennisUSDD.div(toBN(2)), { from: dennis });

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice });

      const aliceCollAfter = await getTroveEntireColl(alice);
      assert.equal(aliceCollAfter, "0");
    });

    it("closeTrove(): sets Trove's stake to zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceStakeBefore = await getTroveStake(alice);
      assert.isTrue(aliceStakeBefore.gt(toBN("0")));

      const dennisUSDD = await usddToken.balanceOf(dennis);
      assert.isTrue(aliceStakeBefore.gt(toBN("0")));
      assert.isTrue(dennisUSDD.gt(toBN("0")));

      // To compensate borrowing fees
      await usddToken.transfer(alice, dennisUSDD.div(toBN(2)), { from: dennis });

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice });

      const stakeAfter = (await troveManager.Troves(alice))[2].toString();
      assert.equal(stakeAfter, "0");
      // check withdrawal was successful
    });

    it("closeTrove(): zero's the troves reward snapshots", async () => {
      // Dennis opens trove and transfers tokens to alice
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));

      // Liquidate Bob
      await troveManager.liquidate(bob);
      assert.isFalse(await sortedTroves.contains(bob));

      // Price bounces back
      await priceFeed.setPrice(dec(200, 18));

      // Alice and Carol open troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // Price drops ...again
      await priceFeed.setPrice(dec(100, 18));

      // Get Alice's pending reward snapshots
      const L_ETH_A_Snapshot = (await troveManager.rewardSnapshots(alice))[0];
      const L_USDDDebt_A_Snapshot = (await troveManager.rewardSnapshots(alice))[1];
      assert.isTrue(L_ETH_A_Snapshot.gt(toBN("0")));
      assert.isTrue(L_USDDDebt_A_Snapshot.gt(toBN("0")));

      // Liquidate Carol
      await troveManager.liquidate(carol);
      assert.isFalse(await sortedTroves.contains(carol));

      // Get Alice's pending reward snapshots after Carol's liquidation. Check above 0
      const L_ETH_Snapshot_A_AfterLiquidation = (await troveManager.rewardSnapshots(alice))[0];
      const L_USDDDebt_Snapshot_A_AfterLiquidation = (await troveManager.rewardSnapshots(alice))[1];

      assert.isTrue(L_ETH_Snapshot_A_AfterLiquidation.gt(toBN("0")));
      assert.isTrue(L_USDDDebt_Snapshot_A_AfterLiquidation.gt(toBN("0")));

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      await priceFeed.setPrice(dec(200, 18));

      // Alice closes trove
      await borrowerOperations.closeTrove({ from: alice });

      // Check Alice's pending reward snapshots are zero
      const L_ETH_Snapshot_A_afterAliceCloses = (await troveManager.rewardSnapshots(alice))[0];
      const L_USDDDebt_Snapshot_A_afterAliceCloses = (await troveManager.rewardSnapshots(alice))[1];

      assert.equal(L_ETH_Snapshot_A_afterAliceCloses, "0");
      assert.equal(L_USDDDebt_Snapshot_A_afterAliceCloses, "0");
    });

    it("closeTrove(): sets trove's status to closed and removes it from sorted troves list", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice);
      const status_Before = alice_Trove_Before[3];

      assert.equal(status_Before, 1);
      assert.isTrue(await sortedTroves.contains(alice));

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice });

      const alice_Trove_After = await troveManager.Troves(alice);
      const status_After = alice_Trove_After[3];

      assert.equal(status_After, 2);
      assert.isFalse(await sortedTroves.contains(alice));
    });

    it("closeTrove(): reduces ActivePool ETH and raw ether by correct amount", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const dennisColl = await getTroveEntireColl(dennis);
      const aliceColl = await getTroveEntireColl(alice);
      assert.isTrue(dennisColl.gt("0"));
      assert.isTrue(aliceColl.gt("0"));

      // Check active Pool ETH before
      const activePool_ETH_before = await activePool.getColl(collToken.address);
      const activePool_RawEther_before = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_before.eq(aliceColl.add(dennisColl)));
      assert.isTrue(activePool_ETH_before.gt(toBN("0")));
      assert.isTrue(activePool_RawEther_before.eq(activePool_ETH_before));

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice });

      // Check after
      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(dennisColl));
      assert.isTrue(activePool_RawEther_After.eq(dennisColl));
    });

    it("closeTrove(): reduces ActivePool debt by correct amount", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const dennisDebt = await getTroveEntireDebt(dennis);
      const aliceDebt = await getTroveEntireDebt(alice);
      assert.isTrue(dennisDebt.gt("0"));
      assert.isTrue(aliceDebt.gt("0"));

      // Check before
      const activePool_Debt_before = await activePool.getUSDDDebt();
      assert.isTrue(activePool_Debt_before.eq(aliceDebt.add(dennisDebt)));
      assert.isTrue(activePool_Debt_before.gt(toBN("0")));

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice });

      // Check after
      const activePool_Debt_After = (await activePool.getUSDDDebt()).toString();
      th.assertIsApproximatelyEqual(activePool_Debt_After, dennisDebt);
    });

    it("closeTrove(): updates the the total stakes", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
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

      // Get individual stakes
      const aliceStakeBefore = await getTroveStake(alice);
      const bobStakeBefore = await getTroveStake(bob);
      const dennisStakeBefore = await getTroveStake(dennis);
      assert.isTrue(aliceStakeBefore.gt("0"));
      assert.isTrue(bobStakeBefore.gt("0"));
      assert.isTrue(dennisStakeBefore.gt("0"));

      const totalStakesBefore = await troveManager.totalStakes();

      assert.isTrue(
        totalStakesBefore.eq(aliceStakeBefore.add(bobStakeBefore).add(dennisStakeBefore))
      );

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      // Alice closes trove
      await borrowerOperations.closeTrove({ from: alice });

      // Check stake and total stakes get updated
      const aliceStakeAfter = await getTroveStake(alice);
      const totalStakesAfter = await troveManager.totalStakes();

      assert.equal(aliceStakeAfter, 0);
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(aliceStakeBefore)));
    });

    if (!withProxy) {
      // TODO: wrap collToken.balanceOf to be able to go through proxies
      it("closeTrove(): sends the correct amount of ETH to the user", async () => {
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: dennis }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: alice }
        });

        const aliceColl = await getTroveEntireColl(alice);
        assert.isTrue(aliceColl.gt(toBN("0")));

        const alice_ETHBalance_Before = web3.utils.toBN(await collToken.balanceOf(alice));

        // to compensate borrowing fees
        await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

        await borrowerOperations.closeTrove({ from: alice, gasPrice: 0 });

        const alice_ETHBalance_After = web3.utils.toBN(await collToken.balanceOf(alice));
        const balanceDiff = alice_ETHBalance_After.sub(alice_ETHBalance_Before);

        assert.isTrue(balanceDiff.eq(aliceColl));
      });
    }

    it("closeTrove(): subtracts the debt of the closed Trove from the Borrower's USDDToken balance", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: dennis }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      const aliceDebt = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebt.gt(toBN("0")));

      // to compensate borrowing fees
      await usddToken.transfer(alice, await usddToken.balanceOf(dennis), { from: dennis });

      const alice_USDDBalance_Before = await usddToken.balanceOf(alice);
      assert.isTrue(alice_USDDBalance_Before.gt(toBN("0")));

      // close trove
      await borrowerOperations.closeTrove({ from: alice });

      // check alice USDD balance after
      const alice_USDDBalance_After = await usddToken.balanceOf(alice);
      th.assertIsApproximatelyEqual(
        alice_USDDBalance_After,
        alice_USDDBalance_Before.sub(aliceDebt.sub(USDD_GAS_COMPENSATION))
      );
    });

    it("closeTrove(): applies pending rewards", async () => {
      // --- SETUP ---
      await openTrove({
        extraUSDDAmount: toBN(dec(1000000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      const whaleDebt = await getTroveEntireDebt(whale);
      const whaleColl = await getTroveEntireColl(whale);

      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      const carolDebt = await getTroveEntireDebt(carol);
      const carolColl = await getTroveEntireColl(carol);

      // Whale transfers to A and B to cover their fees
      await usddToken.transfer(alice, dec(10000, 18), { from: whale });
      await usddToken.transfer(bob, dec(10000, 18), { from: whale });

      // --- TEST ---

      // price drops to 1ETH:100USDD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();

      // liquidate Carol's Trove, Alice and Bob earn rewards.
      const liquidationTx = await troveManager.liquidate(carol, { from: owner });
      const [liquidatedDebt_C, liquidatedColl_C, gasComp_C] = th.getEmittedLiquidationValues(
        liquidationTx
      );

      // Dennis opens a new Trove
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice);
      const alice_ETHrewardSnapshot_Before = alice_rewardSnapshot_Before[0];
      const alice_USDDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1];

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot_Before = bob_rewardSnapshot_Before[0];
      const bob_USDDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1];

      assert.equal(alice_ETHrewardSnapshot_Before, 0);
      assert.equal(alice_USDDDebtRewardSnapshot_Before, 0);
      assert.equal(bob_ETHrewardSnapshot_Before, 0);
      assert.equal(bob_USDDDebtRewardSnapshot_Before, 0);

      const defaultPool_ETH = await defaultPool.getColl(collToken.address);
      const defaultPool_USDDDebt = await defaultPool.getUSDDDebt();

      // Carol's liquidated coll (1 ETH) and drawn debt should have entered the Default Pool
      assert.isAtMost(th.getDifference(defaultPool_ETH, liquidatedColl_C), 100);
      assert.isAtMost(th.getDifference(defaultPool_USDDDebt, liquidatedDebt_C), 100);

      const pendingCollReward_A = await troveManager.getPendingCollReward(alice);
      const pendingDebtReward_A = await troveManager.getPendingUSDDDebtReward(alice);
      assert.isTrue(pendingCollReward_A.gt("0"));
      assert.isTrue(pendingDebtReward_A.gt("0"));

      // Close Alice's trove. Alice's pending rewards should be removed from the DefaultPool when she close.
      await borrowerOperations.closeTrove({ from: alice });

      const defaultPool_ETH_afterAliceCloses = await defaultPool.getColl(collToken.address);
      const defaultPool_USDDDebt_afterAliceCloses = await defaultPool.getUSDDDebt();

      assert.isAtMost(
        th.getDifference(defaultPool_ETH_afterAliceCloses, defaultPool_ETH.sub(pendingCollReward_A)),
        1000
      );
      assert.isAtMost(
        th.getDifference(
          defaultPool_USDDDebt_afterAliceCloses,
          defaultPool_USDDDebt.sub(pendingDebtReward_A)
        ),
        1000
      );

      // whale adjusts trove, pulling their rewards out of DefaultPool
      await adjustTrove({
        maxFee: th._100pct,
        collDeposited: 0,
        collWithdrawal: 0,
        debtChange: dec(1, 18),
        isDebtIncrease: true,
        upperHint: whale,
        lowerHint: whale,
        extraParams: {
          from: whale
        }
      });

      // Close Bob's trove. Expect DefaultPool coll and debt to drop to 0, since closing pulls his rewards out.
      await borrowerOperations.closeTrove({ from: bob });

      const defaultPool_ETH_afterBobCloses = await defaultPool.getColl(collToken.address);
      const defaultPool_USDDDebt_afterBobCloses = await defaultPool.getUSDDDebt();

      assert.isAtMost(th.getDifference(defaultPool_ETH_afterBobCloses, 0), 100000);
      assert.isAtMost(th.getDifference(defaultPool_USDDDebt_afterBobCloses, 0), 100000);
    });

    it("closeTrove(): reverts if borrower has insufficient USDD balance to repay his entire debt", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(15000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      //Confirm Bob's USDD balance is less than his trove debt
      const B_USDDBal = await usddToken.balanceOf(B);
      const B_troveDebt = await getTroveEntireDebt(B);

      assert.isTrue(B_USDDBal.lt(B_troveDebt));

      const closeTrovePromise_B = borrowerOperations.closeTrove({ from: B });

      // Check closing trove reverts
      await assertRevert(
        closeTrovePromise_B,
        "BorrowerOps: Caller doesnt have enough USDD to make repayment"
      );
    });

    // --- openTrove() ---

    if (!withProxy) {
      // TODO: use rawLogs instead of logs
      it("openTrove(): emits a TroveUpdated event with the correct collateral and debt", async () => {
        const txA = (
          await openTrove({
            extraUSDDAmount: toBN(dec(15000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: A }
          })
        ).tx;
        const txB = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: B }
          })
        ).tx;
        const txC = (
          await openTrove({
            extraUSDDAmount: toBN(dec(3000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: C }
          })
        ).tx;

        const A_Coll = await getTroveEntireColl(A);
        const B_Coll = await getTroveEntireColl(B);
        const C_Coll = await getTroveEntireColl(C);
        const A_Debt = await getTroveEntireDebt(A);
        const B_Debt = await getTroveEntireDebt(B);
        const C_Debt = await getTroveEntireDebt(C);

        const A_emittedDebt = toBN(th.getEventArgByName(txA, "TroveUpdated", "_debt"));
        const A_emittedColl = toBN(th.getEventArgByName(txA, "TroveUpdated", "_coll"));
        const B_emittedDebt = toBN(th.getEventArgByName(txB, "TroveUpdated", "_debt"));
        const B_emittedColl = toBN(th.getEventArgByName(txB, "TroveUpdated", "_coll"));
        const C_emittedDebt = toBN(th.getEventArgByName(txC, "TroveUpdated", "_debt"));
        const C_emittedColl = toBN(th.getEventArgByName(txC, "TroveUpdated", "_coll"));

        // Check emitted debt values are correct
        assert.isTrue(A_Debt.eq(A_emittedDebt));
        assert.isTrue(B_Debt.eq(B_emittedDebt));
        assert.isTrue(C_Debt.eq(C_emittedDebt));

        // Check emitted coll values are correct
        assert.isTrue(A_Coll.eq(A_emittedColl));
        assert.isTrue(B_Coll.eq(B_emittedColl));
        assert.isTrue(C_Coll.eq(C_emittedColl));

        const baseRateBefore = await troveManager.baseRate();

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16));
        await troveManager.setLastFeeOpTimeToNow();

        assert.isTrue((await troveManager.baseRate()).gt(baseRateBefore));

        const txD = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: D }
          })
        ).tx;
        const txE = (
          await openTrove({
            extraUSDDAmount: toBN(dec(3000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: E }
          })
        ).tx;
        const D_Coll = await getTroveEntireColl(D);
        const E_Coll = await getTroveEntireColl(E);
        const D_Debt = await getTroveEntireDebt(D);
        const E_Debt = await getTroveEntireDebt(E);

        const D_emittedDebt = toBN(th.getEventArgByName(txD, "TroveUpdated", "_debt"));
        const D_emittedColl = toBN(th.getEventArgByName(txD, "TroveUpdated", "_coll"));

        const E_emittedDebt = toBN(th.getEventArgByName(txE, "TroveUpdated", "_debt"));
        const E_emittedColl = toBN(th.getEventArgByName(txE, "TroveUpdated", "_coll"));

        // Check emitted debt values are correct
        assert.isTrue(D_Debt.eq(D_emittedDebt));
        assert.isTrue(E_Debt.eq(E_emittedDebt));

        // Check emitted coll values are correct
        assert.isTrue(D_Coll.eq(D_emittedColl));
        assert.isTrue(E_Coll.eq(E_emittedColl));
      });
    }

    it("openTrove(): Opens a trove with net debt >= minimum net debt", async () => {
      // Add 1 wei to correct for rounding error in helper function
      const txA = (
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(1))),
          upperHint: A,
          lowerHint: A,
          extraParams: { from: A, value: toBN(dec(100, 30)) }
        })
      ).tx;

      assert.isTrue(txA.receipt.status);
      assert.isTrue(await sortedTroves.contains(A));

      const txC = (
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(dec(47789898, 22)))),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: C,
            value: toBN(dec(100, 30))
          }
        })
      ).tx;

      assert.isTrue(txC.receipt.status);
      assert.isTrue(await sortedTroves.contains(C));
    });

    it("openTrove(): reverts if net debt < minimum net debt", async () => {
      const txAPromise = (
        await openTrove({
          txPromise: true,
          maxFeePercentage: th._100pct,
          usddAmount: toBN(0),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: A,
            value: toBN(dec(100, 30))
          }
        })
      ).txPromise;
      await assertRevert(txAPromise, "revert");

      const txBPromise = (
        await openTrove({
          txPromise: true,
          maxFeePercentage: th._100pct,
          usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT.sub(toBN(1))),
          upperHint: B,
          lowerHint: B,
          extraParams: {
            from: B,
            value: toBN(dec(100, 30))
          }
        })
      ).txPromise;
      await assertRevert(txBPromise, "revert");

      const txCPromise = (
        await openTrove({
          txPromise: true,
          maxFeePercentage: th._100pct,
          usddAmount: MIN_NET_DEBT.sub(toBN(dec(173, 18))),
          upperHint: C,
          lowerHint: C,
          extraParams: {
            from: C,
            value: toBN(dec(100, 30))
          }
        })
      ).txPromise;
      await assertRevert(txCPromise, "revert");
    });

    it("openTrove(): decays a non-zero base rate", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(37, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(12, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const baseRate_3 = await troveManager.baseRate();
      assert.isTrue(baseRate_3.lt(baseRate_2));
    });

    it("openTrove(): doesn't change base rate if it is already zero", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(37, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate();
      assert.equal(baseRate_2, "0");

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider);

      // E opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(12, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const baseRate_3 = await troveManager.baseRate();
      assert.equal(baseRate_3, "0");
    });

    it("openTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime();

      // Borrower D triggers a fee
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1));

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider);

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3);
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600));

      // Borrower E triggers a fee
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime();

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1));
    });

    it("openTrove(): reverts if max fee > 100%", async () => {
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: dec(2, 18),
            usddAmount: toBN(dec(10000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: A,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: "1000000000000000001",
            usddAmount: toBN(dec(20000, 18)),
            upperHint: B,
            lowerHint: B,
            extraParams: {
              from: B,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Max fee percentage must be between 0.5% and 100%"
      );
    });

    it("openTrove(): reverts if max fee < 0.5% in Normal mode", async () => {
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: 0,
            usddAmount: toBN(dec(195000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: A,
              value: toBN(dec(1200, "ether"))
            }
          })
        ).txPromise,
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: 1,
            usddAmount: toBN(dec(195000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: A,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Max fee percentage must be between 0.5% and 100%"
      );
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: "4999999999999999",
            usddAmount: toBN(dec(195000, 18)),
            upperHint: B,
            lowerHint: B,
            extraParams: {
              from: B,
              value: toBN(dec(1200, "ether"))
            }
          })
        ).txPromise,
        "Max fee percentage must be between 0.5% and 100%"
      );
    });

    it("openTrove(): allows max fee < 0.5% in Recovery Mode", async () => {
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(195000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: {
          from: A,
          value: toBN(dec(2000, "ether"))
        }
      });
      await priceFeed.setPrice(dec(100, 18));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await openTrove({
        maxFeePercentage: 0,
        usddAmount: toBN(dec(195000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: {
          from: B,
          value: toBN(dec(3100, "ether"))
        }
      });
      await priceFeed.setPrice(dec(50, 18));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await openTrove({
        maxFeePercentage: 1,
        usddAmount: toBN(dec(19500, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: {
          from: C,
          value: toBN(dec(3100, "ether"))
        }
      });
      await priceFeed.setPrice(dec(25, 18));
      assert.isTrue(await th.checkRecoveryMode(contracts));

      await openTrove({
        maxFeePercentage: "4999999999999999",
        usddAmount: toBN(dec(19500, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D,
          value: toBN(dec(3100, "ether"))
        }
      });
    });

    it("openTrove(): reverts if fee exceeds max fee percentage", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      const totalSupply = await usddToken.totalSupply();

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      //       actual fee percentage: 0.005000000186264514
      // user's max fee percentage:  0.0049999999999999999
      let borrowingRate = await troveManager.getBorrowingRate(); // expect max(0.5 + 5%, 5%) rate
      assert.equal(borrowingRate, dec(5, 16));

      const lessThan5pct = "49999999999999999";
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: lessThan5pct,
            usddAmount: toBN(dec(30000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: A,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Fee exceeded provided maximum"
      );

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));
      // Attempt with maxFee 1%
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: dec(1, 16),
            usddAmount: toBN(dec(30000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: D,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Fee exceeded provided maximum"
      );

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));
      // Attempt with maxFee 3.754%
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: dec(3754, 13),
            usddAmount: toBN(dec(30000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: D,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Fee exceeded provided maximum"
      );

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));
      // Attempt with maxFee 1e-16%
      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: dec(5, 15),
            usddAmount: toBN(dec(30000, 18)),
            upperHint: A,
            lowerHint: A,
            extraParams: {
              from: D,
              value: toBN(dec(1000, "ether"))
            }
          })
        ).txPromise,
        "Fee exceeded provided maximum"
      );
    });

    it("openTrove(): succeeds when fee is less than max fee percentage", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      let borrowingRate = await troveManager.getBorrowingRate(); // expect min(0.5 + 5%, 5%) rate
      assert.equal(borrowingRate, dec(5, 16));

      // Attempt with maxFee > 5%
      const moreThan5pct = "50000000000000001";

      const tx1 = (
        await openTrove({
          maxFeePercentage: moreThan5pct,
          usddAmount: toBN(dec(10000, 18)),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: D,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      assert.isTrue(tx1.receipt.status);

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));

      // Attempt with maxFee = 5%

      const tx2 = (
        await openTrove({
          maxFeePercentage: dec(5, 16),
          usddAmount: toBN(dec(10000, 18)),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: H,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      assert.isTrue(tx2.receipt.status);

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));

      // Attempt with maxFee 10%

      const tx3 = (
        await openTrove({
          maxFeePercentage: dec(1, 17),
          usddAmount: toBN(dec(10000, 18)),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: E,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      assert.isTrue(tx3.receipt.status);

      borrowingRate = await troveManager.getBorrowingRate(); // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16));

      // Attempt with maxFee 37.659%

      const tx4 = (
        await openTrove({
          maxFeePercentage: dec(37659, 13),
          usddAmount: toBN(dec(10000, 18)),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: F,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      assert.isTrue(tx4.receipt.status);

      // Attempt with maxFee 100%

      const tx5 = (
        await openTrove({
          maxFeePercentage: dec(1, 18),
          usddAmount: toBN(dec(10000, 18)),
          upperHint: A,
          lowerHint: A,
          extraParams: {
            from: G,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      assert.isTrue(tx5.receipt.status);
    });

    it("openTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 59 minutes pass
      th.fastForwardTime(3540, web3.currentProvider);

      // Assume Borrower also owns accounts D and E
      // Borrower triggers a fee, before decay interval has passed
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // 1 minute pass
      th.fastForwardTime(3540, web3.currentProvider);

      // Borrower triggers another fee
      await openTrove({
        extraUSDDAmount: toBN(dec(1, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: E }
      });

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate();
      assert.isTrue(baseRate_2.lt(baseRate_1));
    });

    it("openTrove(): borrowing at non-zero base rate sends USDD fee to DEFT staking contract", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT USDD balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check DEFT USDD balance after has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));
    });

    if (!withProxy) {
      // TODO: use rawLogs instead of logs
      it("openTrove(): borrowing at non-zero base records the (drawn debt + fee  + liq. reserve) on the Trove struct", async () => {
        // time fast-forwards 1 year, and alice stakes 1 DEFT
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
        await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
        await deftStaking.stake(dec(1, 18), { from: alice });

        await openTrove({
          extraUSDDAmount: toBN(dec(10000, 18)),
          ICR: toBN(dec(10, 18)),
          extraParams: { from: whale }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(20000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: A }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(30000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: B }
        });
        await openTrove({
          extraUSDDAmount: toBN(dec(40000, 18)),
          ICR: toBN(dec(2, 18)),
          extraParams: { from: C }
        });

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16));
        await troveManager.setLastFeeOpTimeToNow();

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate();
        assert.isTrue(baseRate_1.gt(toBN("0")));

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider);

        const D_USDDRequest = toBN(dec(20000, 18));

        // D withdraws USDD
        const openTroveTx = (
          await openTrove({
            maxFeePercentage: th._100pct,
            usddAmount: D_USDDRequest,
            upperHint: ZERO_ADDRESS,
            lowerHint: ZERO_ADDRESS,
            extraParams: {
              from: D,
              value: toBN(dec(200, "ether"))
            }
          })
        ).tx;

        const emittedFee = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(openTroveTx));
        assert.isTrue(toBN(emittedFee).gt(toBN("0")));

        const newDebt = (await troveManager.Troves(D))[0];

        // Check debt on Trove struct equals drawn debt plus emitted fee
        th.assertIsApproximatelyEqual(
          newDebt,
          D_USDDRequest.add(emittedFee).add(USDD_GAS_COMPENSATION),
          100000
        );
      });
    }

    it("openTrove(): Borrowing at non-zero base rate increases the DEFT staking contract USDD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT contract USDD fees-per-unit-staked is zero
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.equal(F_USDD_Before, "0");

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(37, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check DEFT contract USDD fees-per-unit-staked has increased
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt(F_USDD_Before));
    });

    it("openTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and alice stakes 1 DEFT
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);
      await deftToken.approve(deftStaking.address, dec(1, 18), { from: alice });
      await deftStaking.stake(dec(1, 18), { from: alice });

      // Check DEFT Staking contract balance before == 0
      const deftStaking_USDDBalance_Before = await usddToken.balanceOf(deftStaking.address);
      assert.equal(deftStaking_USDDBalance_Before, "0");

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(20000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(30000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(40000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16));
      await troveManager.setLastFeeOpTimeToNow();

      // Check baseRate is non-zero
      const baseRate_1 = await troveManager.baseRate();
      assert.isTrue(baseRate_1.gt(toBN("0")));

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // D opens trove
      const USDDRequest_D = toBN(dec(40000, 18));
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: USDDRequest_D,
        upperHint: D,
        lowerHint: D,
        extraParams: {
          from: D,
          value: toBN(dec(500, "ether"))
        }
      });

      // Check DEFT staking USDD balance has increased
      const deftStaking_USDDBalance_After = await usddToken.balanceOf(deftStaking.address);
      assert.isTrue(deftStaking_USDDBalance_After.gt(deftStaking_USDDBalance_Before));

      // Check D's USDD balance now equals their requested USDD
      const USDDBalance_D = await usddToken.balanceOf(D);
      assert.isTrue(USDDRequest_D.eq(USDDBalance_D));
    });

    it("openTrove(): Borrowing at zero base rate changes the DEFT staking contract USDD fees-per-unit-staked", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: C }
      });

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate();
      assert.equal(baseRate_1, "0");

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider);

      // Check USDD reward per DEFT staked == 0
      const F_USDD_Before = await deftStaking.F_USDD();
      assert.equal(F_USDD_Before, "0");

      // A stakes DEFT
      await deftToken.mint(A, dec(100, 18));
      await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
      await deftStaking.stake(dec(100, 18), { from: A });

      // D opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(37, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: D }
      });

      // Check USDD reward per DEFT staked > 0
      const F_USDD_After = await deftStaking.F_USDD();
      assert.isTrue(F_USDD_After.gt(toBN("0")));
    });

    it("openTrove(): Borrowing at zero base rate charges minimum fee", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      const USDDRequest = toBN(dec(10000, 18));
      const txC = (
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: USDDRequest,
          upperHint: ZERO_ADDRESS,
          lowerHint: ZERO_ADDRESS,
          extraParams: {
            from: C,
            value: toBN(dec(100, "ether"))
          }
        })
      ).tx;
      const _USDDFee = toBN(th.getEventArgByName(txC, "USDDBorrowingFeePaid", "_USDDFee"));

      const expectedFee = BORROWING_FEE_FLOOR.mul(toBN(USDDRequest)).div(toBN(dec(1, 18)));
      assert.isTrue(_USDDFee.eq(expectedFee));
    });

    it("openTrove(): reverts when system is in Recovery Mode and ICR < CCR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      assert.isFalse(await th.checkRecoveryMode(contracts));

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(dec(105, 18));

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Bob tries to open a trove with 149% ICR during Recovery Mode
      try {
        const txBob = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(149, 16)),
            extraParams: { from: alice }
          })
        ).tx;
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("openTrove(): reverts when trove ICR < MCR", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Bob attempts to open a 109% ICR trove in Normal Mode
      try {
        const txBob = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(109, 16)),
            extraParams: { from: bob }
          })
        ).tx;
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(dec(105, 18));

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Bob attempts to open a 109% ICR trove in Recovery Mode
      try {
        const txBob = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(109, 16)),
            extraParams: { from: bob }
          })
        ).tx;
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("openTrove(): reverts when opening the trove would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18));

      // Alice creates trove with 150% ICR.  System TCR = 150%.
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: alice }
      });

      const TCR = await th.getTCR(contracts);
      assert.equal(TCR, dec(150, 16));

      // Bob attempts to open a trove with ICR = 149%
      // System TCR would fall below 150%
      try {
        const txBob = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(149, 16)),
            extraParams: { from: bob }
          })
        ).tx;
        assert.isFalse(txBob.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("openTrove(): reverts if trove is already active", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(10, 18)),
        extraParams: { from: whale }
      });

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: bob }
      });

      try {
        const txB_1 = (
          await openTrove({
            extraUSDDAmount: toBN(dec(5000, 18)),
            ICR: toBN(dec(3, 18)),
            extraParams: { from: bob }
          })
        ).tx;

        assert.isFalse(txB_1.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }

      try {
        const txB_2 = (await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })).tx;

        assert.isFalse(txB_2.receipt.status);
      } catch (err) {
        assert.include(err.message, "revert");
      }
    });

    it("openTrove(): Can open a trove with ICR >= CCR when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~150%
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: bob }
      });

      const TCR = (await th.getTCR(contracts)).toString();
      assert.equal(TCR, "1500000000000000000");

      // price drops to 1ETH:100USDD, reducing TCR below 150%
      await priceFeed.setPrice("100000000000000000000");
      const price = await priceFeed.getPrice();

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Carol opens at 150% ICR in Recovery Mode
      const txCarol = (
        await openTrove({
          extraUSDDAmount: toBN(dec(5000, 18)),
          ICR: toBN(dec(15, 17)),
          extraParams: { from: carol }
        })
      ).tx;
      assert.isTrue(txCarol.receipt.status);
      assert.isTrue(await sortedTroves.contains(carol));

      const carol_TroveStatus = await troveManager.getTroveStatus(carol);
      assert.equal(carol_TroveStatus, 1);

      const carolICR = await troveManager.getCurrentICR(carol, price);
      assert.isTrue(carolICR.gt(toBN(dec(150, 16))));
    });

    it("openTrove(): Reverts opening a trove with min debt when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~150%
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: bob }
      });

      const TCR = (await th.getTCR(contracts)).toString();
      assert.equal(TCR, "1500000000000000000");

      // price drops to 1ETH:100USDD, reducing TCR below 150%
      await priceFeed.setPrice("100000000000000000000");

      assert.isTrue(await th.checkRecoveryMode(contracts));

      await assertRevert(
        (
          await openTrove({
            txPromise: true,
            maxFeePercentage: th._100pct,
            usddAmount: await getNetBorrowingAmount(MIN_NET_DEBT),
            upperHint: carol,
            lowerHint: carol,
            extraParams: {
              from: carol,
              value: toBN(dec(1, "ether"))
            }
          })
        ).txPromise
      );
    });

    it("openTrove(): creates a new Trove and assigns the correct collateral and debt amount", async () => {
      const debt_Before = await getTroveEntireDebt(alice);
      const coll_Before = await getTroveEntireColl(alice);
      const status_Before = await troveManager.getTroveStatus(alice);

      // check coll and debt before
      assert.equal(debt_Before, 0);
      assert.equal(coll_Before, 0);

      // check non-existent status
      assert.equal(status_Before, 0);

      const USDDRequest = MIN_NET_DEBT;
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: MIN_NET_DEBT,
        upperHint: carol,
        lowerHint: carol,
        extraParams: {
          from: alice,
          value: toBN(dec(100, "ether"))
        }
      });

      // Get the expected debt based on the USDD request (adding fee and liq. reserve on top)
      const expectedDebt = USDDRequest.add(await troveManager.getBorrowingFee(USDDRequest)).add(
        USDD_GAS_COMPENSATION
      );

      const debt_After = await getTroveEntireDebt(alice);
      const coll_After = await getTroveEntireColl(alice);
      const status_After = await troveManager.getTroveStatus(alice);

      // check coll and debt after
      assert.isTrue(coll_After.gt("0"));
      assert.isTrue(debt_After.gt("0"));

      assert.isTrue(debt_After.eq(expectedDebt));

      // check active status
      assert.equal(status_After, 1);
    });

    it("openTrove(): adds Trove owner to TroveOwners array", async () => {
      const TroveOwnersCount_Before = (await troveManager.getTroveOwnersCount()).toString();
      assert.equal(TroveOwnersCount_Before, "0");

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(15, 17)),
        extraParams: { from: alice }
      });

      const TroveOwnersCount_After = (await troveManager.getTroveOwnersCount()).toString();
      assert.equal(TroveOwnersCount_After, "1");
    });

    it("openTrove(): creates a stake and adds it to total stakes", async () => {
      const aliceStakeBefore = await getTroveStake(alice);
      const totalStakesBefore = await troveManager.totalStakes();

      assert.equal(aliceStakeBefore, "0");
      assert.equal(totalStakesBefore, "0");

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      const aliceCollAfter = await getTroveEntireColl(alice);
      const aliceStakeAfter = await getTroveStake(alice);
      assert.isTrue(aliceCollAfter.gt(toBN("0")));
      assert.isTrue(aliceStakeAfter.eq(aliceCollAfter));

      const totalStakesAfter = await troveManager.totalStakes();

      assert.isTrue(totalStakesAfter.eq(aliceStakeAfter));
    });

    it("openTrove(): inserts Trove to Sorted Troves list", async () => {
      // Check before
      const aliceTroveInList_Before = await sortedTroves.contains(alice);
      const listIsEmpty_Before = await sortedTroves.isEmpty();
      assert.equal(aliceTroveInList_Before, false);
      assert.equal(listIsEmpty_Before, true);

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // check after
      const aliceTroveInList_After = await sortedTroves.contains(alice);
      const listIsEmpty_After = await sortedTroves.isEmpty();
      assert.equal(aliceTroveInList_After, true);
      assert.equal(listIsEmpty_After, false);
    });

    it("openTrove(): Increases the activePool ETH and raw ether balance by correct amount", async () => {
      const activePool_ETH_Before = await activePool.getColl(collToken.address);
      const activePool_RawEther_Before = await collToken.balanceOf(activePool.address);
      assert.equal(activePool_ETH_Before, 0);
      assert.equal(activePool_RawEther_Before, 0);

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      const aliceCollAfter = await getTroveEntireColl(alice);

      const activePool_ETH_After = await activePool.getColl(collToken.address);
      const activePool_RawEther_After = toBN(await collToken.balanceOf(activePool.address));
      assert.isTrue(activePool_ETH_After.eq(aliceCollAfter));
      assert.isTrue(activePool_RawEther_After.eq(aliceCollAfter));
    });

    it("openTrove(): records up-to-date initial snapshots of L_ETH and L_USDDDebt", async () => {
      // --- SETUP ---

      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // --- TEST ---

      // price drops to 1ETH:100USDD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(dec(100, 18));

      // close Carol's Trove, liquidating her 1 ether and 180USDD.
      const liquidationTx = await troveManager.liquidate(carol, { from: owner });
      const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
        liquidationTx
      );

      /* with total stakes = 10 ether, after liquidation, L_ETH should equal 1/10 ether per-ether-staked,
       and L_USDD should equal 18 USDD per-ether-staked. */

      const L_ETH = await troveManager.L_COLL();
      const L_USDD = await troveManager.L_USDDDebt();

      assert.isTrue(L_ETH.gt(toBN("0")));
      assert.isTrue(L_USDD.gt(toBN("0")));

      // Bob opens trove
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: bob }
      });

      // Check Bob's snapshots of L_ETH and L_USDD equal the respective current values
      const bob_rewardSnapshot = await troveManager.rewardSnapshots(bob);
      const bob_ETHrewardSnapshot = bob_rewardSnapshot[0];
      const bob_USDDDebtRewardSnapshot = bob_rewardSnapshot[1];

      assert.isAtMost(th.getDifference(bob_ETHrewardSnapshot, L_ETH), 1000);
      assert.isAtMost(th.getDifference(bob_USDDDebtRewardSnapshot, L_USDD), 1000);
    });

    it("openTrove(): allows a user to open a Trove, then close it, then re-open it", async () => {
      // Open Troves
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: whale }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: carol }
      });

      // Check Trove is active
      const alice_Trove_1 = await troveManager.Troves(alice);
      const status_1 = alice_Trove_1[3];
      assert.equal(status_1, 1);
      assert.isTrue(await sortedTroves.contains(alice));

      // to compensate borrowing fees
      await usddToken.transfer(alice, dec(10000, 18), { from: whale });

      // Repay and close Trove
      await borrowerOperations.closeTrove({ from: alice });

      // Check Trove is closed
      const alice_Trove_2 = await troveManager.Troves(alice);
      const status_2 = alice_Trove_2[3];
      assert.equal(status_2, 2);
      assert.isFalse(await sortedTroves.contains(alice));

      // Re-open Trove
      await openTrove({
        extraUSDDAmount: toBN(dec(5000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });

      // Check Trove is re-opened
      const alice_Trove_3 = await troveManager.Troves(alice);
      const status_3 = alice_Trove_3[3];
      assert.equal(status_3, 1);
      assert.isTrue(await sortedTroves.contains(alice));
    });

    it("openTrove(): increases the Trove's USDD debt by the correct amount", async () => {
      // check before
      const alice_Trove_Before = await troveManager.Troves(alice);
      const debt_Before = alice_Trove_Before[0];
      assert.equal(debt_Before, 0);

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice,
          value: toBN(dec(100, "ether"))
        }
      });
      // check after
      const alice_Trove_After = await troveManager.Troves(alice);
      const debt_After = alice_Trove_After[0];
      th.assertIsApproximatelyEqual(debt_After, dec(10000, 18), 10000);
    });

    it("openTrove(): increases USDD debt in ActivePool by the debt of the trove", async () => {
      const activePool_USDDDebt_Before = await activePool.getUSDDDebt();
      assert.equal(activePool_USDDDebt_Before, 0);

      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: alice }
      });
      const aliceDebt = await getTroveEntireDebt(alice);
      assert.isTrue(aliceDebt.gt(toBN("0")));

      const activePool_USDDDebt_After = await activePool.getUSDDDebt();
      assert.isTrue(activePool_USDDDebt_After.eq(aliceDebt));
    });

    it("openTrove(): increases user USDDToken balance by correct amount", async () => {
      // check before
      const alice_USDDTokenBalance_Before = await usddToken.balanceOf(alice);
      assert.equal(alice_USDDTokenBalance_Before, 0);
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: alice,
        lowerHint: alice,
        extraParams: {
          from: alice,
          value: toBN(dec(100, "ether"))
        }
      });

      // check after
      const alice_USDDTokenBalance_After = await usddToken.balanceOf(alice);
      assert.equal(alice_USDDTokenBalance_After, dec(10000, 18));
    });

    //  --- getNewICRFromTroveChange - (external wrapper in Tester contract calls internal function) ---

    describe("getNewICRFromTroveChange() returns the correct ICR", async () => {
      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = 0;
        const debtChange = 0;

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.equal(newICR, "2000000000000000000");
      });

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = 0;
        const debtChange = dec(50, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.isAtMost(th.getDifference(newICR, "1333333333333333333"), 100);
      });

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = 0;
        const debtChange = dec(50, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            false,
            price
          )
        ).toString();
        assert.equal(newICR, "4000000000000000000");
      });

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(1, "ether");
        const debtChange = 0;

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.equal(newICR, "4000000000000000000");
      });

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(5, 17);
        const debtChange = 0;

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            false,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.equal(newICR, "1000000000000000000");
      });

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(5, 17);
        const debtChange = dec(50, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            false,
            debtChange,
            false,
            price
          )
        ).toString();
        assert.equal(newICR, "2000000000000000000");
      });

      // +ve, +ve
      it("collChange is positive, debtChange is positive", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(1, "ether");
        const debtChange = dec(100, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.equal(newICR, "2000000000000000000");
      });

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(1, "ether");
        const debtChange = dec(50, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            true,
            debtChange,
            false,
            price
          )
        ).toString();
        assert.equal(newICR, "8000000000000000000");
      });

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        price = await priceFeed.getPrice();
        const initialColl = dec(1, "ether");
        const initialDebt = dec(100, 18);
        const collChange = dec(5, 17);
        const debtChange = dec(100, 18);

        const newICR = (
          await borrowerOperations.getNewICRFromTroveChange(
            initialColl,
            initialDebt,
            collChange,
            false,
            debtChange,
            true,
            price
          )
        ).toString();
        assert.equal(newICR, "500000000000000000");
      });
    });

    // --- getCompositeDebt ---

    it("getCompositeDebt(): returns debt + gas comp", async () => {
      const res1 = await borrowerOperations.getCompositeDebt("0");
      assert.equal(res1, USDD_GAS_COMPENSATION.toString());

      const res2 = await borrowerOperations.getCompositeDebt(dec(90, 18));
      th.assertIsApproximatelyEqual(res2, USDD_GAS_COMPENSATION.add(toBN(dec(90, 18))));

      const res3 = await borrowerOperations.getCompositeDebt(dec(24423422357345049, 12));
      th.assertIsApproximatelyEqual(
        res3,
        USDD_GAS_COMPENSATION.add(toBN(dec(24423422357345049, 12)))
      );
    });

    //  --- getNewTCRFromTroveChange  - (external wrapper in Tester contract calls internal function) ---

    describe("getNewTCRFromTroveChange() returns the correct TCR", async () => {
      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });

        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = 0;
        const debtChange = 0;
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = 0;
        const debtChange = dec(200, 18);
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();
        // --- TEST ---
        const collChange = 0;
        const debtChange = dec(100, 18);
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          false,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();
        // --- TEST ---
        const collChange = dec(2, "ether");
        const debtChange = 0;
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .add(toBN(collChange))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = dec(1, 18);
        const debtChange = 0;
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          false,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .sub(toBN(dec(1, "ether")))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = dec(1, 18);
        const debtChange = dec(100, 18);
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          false,
          debtChange,
          false,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .sub(toBN(dec(1, "ether")))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // +ve, +ve
      it("collChange is positive, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = dec(1, "ether");
        const debtChange = dec(100, 18);
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .add(toBN(dec(1, "ether")))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(dec(100, 18))));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = dec(1, "ether");
        const debtChange = dec(100, 18);
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          true,
          debtChange,
          false,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .add(toBN(dec(1, "ether")))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))));

        assert.isTrue(newTCR.eq(expectedTCR));
      });

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, "ether"));
        const troveTotalDebt = toBN(dec(100000, 18));
        const troveUSDDAmount = await getOpenTroveUSDDAmount(troveTotalDebt);
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: alice,
          lowerHint: alice,
          extraParams: {
            from: alice,
            value: troveColl
          }
        });
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: troveUSDDAmount,
          upperHint: bob,
          lowerHint: bob,
          extraParams: {
            from: bob,
            value: troveColl
          }
        });

        await priceFeed.setPrice(dec(100, 18));

        const liquidationTx = await troveManager.liquidate(bob);
        assert.isFalse(await sortedTroves.contains(bob));

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(
          liquidationTx
        );

        await priceFeed.setPrice(dec(200, 18));
        const price = await priceFeed.getPrice();

        // --- TEST ---
        const collChange = dec(1, 18);
        const debtChange = await getNetBorrowingAmount(dec(200, 18));
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(
          collChange,
          false,
          debtChange,
          true,
          price
        );

        const expectedTCR = troveColl
          .add(liquidatedColl)
          .sub(toBN(collChange))
          .mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)));

        assert.isTrue(newTCR.eq(expectedTCR));
      });
    });

    // if (!withProxy) {
    //   it("closeTrove(): fails if owner cannot receive ETH", async () => {
    //     const nonPayable = await NonPayable.new();

    //     // we need 2 troves to be able to close 1 and have 1 remaining in the system
    //     await openTrove({
    //       maxFeePercentage: th._100pct,
    //       usddAmount: toBN(dec(100000, 18)),
    //       upperHint: alice,
    //       lowerHint: alice,
    //       extraParams: {
    //         from: alice,
    //         value: toBN(dec(1000, "ether"))
    //       }
    //     });

    //     // Alice sends USDD to NonPayable so its USDD balance covers its debt
    //     await usddToken.transfer(nonPayable.address, dec(10000, 18), { from: alice });

    //     // open trove from NonPayable proxy contract
    //     const _100pctHex = "0xde0b6b3a7640000";
    //     const _1e25Hex = "0xd3c21bcecceda1000000";
    //     const openTroveData = th.getTransactionData(
    //       "openTrove(uint256,uint256,uint256,address,address)",
    //       [_100pctHex, dec(10000, "ether"), _1e25Hex, "0x0", "0x0"]
    //     );
    //     await nonPayable.forward(borrowerOperations.address, openTroveData);
    //     assert.equal(
    //       (await troveManager.getTroveStatus(nonPayable.address)).toString(),
    //       "1",
    //       "NonPayable proxy should have a trove"
    //     );
    //     assert.isFalse(
    //       await th.checkRecoveryMode(contracts),
    //       "System should not be in Recovery Mode"
    //     );
    //     // open trove from NonPayable proxy contract
    //     const closeTroveData = th.getTransactionData("closeTrove()", []);
    //     await th.assertRevert(
    //       nonPayable.forward(borrowerOperations.address, closeTroveData),
    //       "ActivePool: sending ETH failed"
    //     );
    //   });
    // }
  };

  describe("Without proxy", async () => {
    testCorpus({ withProxy: false });
  });

  // describe('With proxy', async () => {
  //   testCorpus({ withProxy: true })
  // })
});

contract("Reset chain state", async accounts => {});

/* TODO:

 1) Test SortedList re-ordering by ICR. ICR ratio
 changes with addColl, withdrawColl, withdrawUSDD, repayUSDD, etc. Can split them up and put them with
 individual functions, or give ordering it's own 'describe' block.

 2)In security phase:
 -'Negative' tests for all the above functions.
 */
