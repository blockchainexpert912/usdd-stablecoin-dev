const Decimal = require("decimal.js");
const deploymentHelper = require("../utils/deploymentHelpers.js");
const { BNConverter } = require("../utils/BNConverter.js");
const testHelpers = require("../utils/testHelpers.js");

const DEFTStakingTester = artifacts.require("DEFTStakingTester");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const NonPayable = artifacts.require("./NonPayable.sol");

const th = testHelpers.TestHelper;
const timeValues = testHelpers.TimeValues;
const dec = th.dec;
const assertRevert = th.assertRevert;

const toBN = th.toBN;
const ZERO = th.toBN("0");

/* NOTE: These tests do not test for specific ETH and USDD gain values. They only test that the
 * gains are non-zero, occur when they should, and are in correct proportion to the user's stake.
 *
 * Specific ETH/USDD gain values will depend on the final fee schedule used, and the final choices for
 * parameters BETA and MINUTE_DECAY_FACTOR in the TroveManager, which are still TBD based on economic
 * modelling.
 *
 */

contract("DEFTStaking revenue share tests", async accounts => {
  const [owner, A, B, C, D, E, F, G, whale, alice] = accounts;

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

  const openTrove = async params => th.openTrove(contracts, params);

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    contracts.troveManager = await TroveManagerTester.new();
    contracts = await deploymentHelper.deployUSDDTokenTester(contracts);
    const DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();
    deftToken = DEFTContracts.deftToken;
    const communityIssuance = DEFTContracts.communityIssuance;
    await deploymentHelper.connectDEFTContracts(DEFTContracts);
    await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
    await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

    const issuanceCap = BNConverter.makeBN18(32000000);
    deftToken.mint(communityIssuance.address, issuanceCap);
    await communityIssuance.start(issuanceCap);

    nonPayable = await NonPayable.new();
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
    await deftToken.mint(alice, dec(1000, 18));
  });

  it("stake(): reverts if amount is zero", async () => {
    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // console.log(`A deft bal: ${await deftToken.balanceOf(A)}`)

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await assertRevert(deftStaking.stake(0, { from: A }), "DEFTStaking: Amount must be non-zero");
  });

  it("ETH fee per DEFT staked increases when a redemption fee is triggered and totalStakes > 0", async () => {
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

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // console.log(`A deft bal: ${await deftToken.balanceOf(A)}`)

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(100, 18), { from: A });

    // Check ETH fee per unit staked is zero
    const F_COLLS_Before = await deftStaking.F_COLLS(collToken.address);
    assert.equal(F_COLLS_Before, "0");

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee emitted in event is non-zero
    const emittedETHFee = toBN((await th.getEmittedRedemptionValues(redemptionTx))[3]);
    assert.isTrue(emittedETHFee.gt(toBN("0")));

    // Check ETH fee per unit staked has increased by correct amount
    const F_COLLS_After = await deftStaking.F_COLLS(collToken.address);

    // Expect fee per unit staked = fee/100, since there is 100 USDD totalStaked
    const expected_F_COLLS_After = emittedETHFee.div(toBN("100"));

    assert.isTrue(expected_F_COLLS_After.eq(F_COLLS_After));
  });

  it("ETH fee per DEFT staked doesn't change when a redemption fee is triggered and totalStakes == 0", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // Check ETH fee per unit staked is zero
    const F_COLLS_Before = await deftStaking.F_COLLS(collToken.address);
    assert.equal(F_COLLS_Before, "0");

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee emitted in event is non-zero
    const emittedETHFee = toBN((await th.getEmittedRedemptionValues(redemptionTx))[3]);
    assert.isTrue(emittedETHFee.gt(toBN("0")));

    // Check ETH fee per unit staked has not increased
    const F_COLLS_After = await deftStaking.F_COLLS(collToken.address);
    assert.equal(F_COLLS_After, "0");
  });

  it("USDD fee per DEFT staked increases when a redemption fee is triggered and totalStakes > 0", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(100, 18), { from: A });

    // Check USDD fee per unit staked is zero
    const F_USDD_Before = await deftStaking.F_COLLS(collToken.address);
    assert.equal(F_USDD_Before, "0");

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // Check base rate is now non-zero
    const baseRate = await troveManager.baseRate();
    assert.isTrue(baseRate.gt(toBN("0")));

    // D draws debt
    const tx = await borrowerOperations.withdrawUSDD(th._100pct, dec(27, 18), D, D, { from: D });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(tx));
    assert.isTrue(emittedUSDDFee.gt(toBN("0")));

    // Check USDD fee per unit staked has increased by correct amount
    const F_USDD_After = await deftStaking.F_USDD();

    // Expect fee per unit staked = fee/100, since there is 100 USDD totalStaked
    const expected_F_USDD_After = emittedUSDDFee.div(toBN("100"));

    assert.isTrue(expected_F_USDD_After.eq(F_USDD_After));
  });

  it("USDD fee per DEFT staked doesn't change when a redemption fee is triggered and totalStakes == 0", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // Check USDD fee per unit staked is zero
    const F_USDD_Before = await deftStaking.F_COLLS(collToken.address);
    assert.equal(F_USDD_Before, "0");

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // Check base rate is now non-zero
    const baseRate = await troveManager.baseRate();
    assert.isTrue(baseRate.gt(toBN("0")));

    // D draws debt
    const tx = await borrowerOperations.withdrawUSDD(th._100pct, dec(27, 18), D, D, { from: D });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(tx));
    assert.isTrue(emittedUSDDFee.gt(toBN("0")));

    // Check USDD fee per unit staked did not increase, is still zero
    const F_USDD_After = await deftStaking.F_USDD();
    assert.equal(F_USDD_After, "0");
  });

  it("DEFT Staking: A single staker earns all ETH and DEFT fees that occur", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(100, 18), { from: A });

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    let F_COLLS_Before = await deftStaking.F_COLLS(collToken.address);
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    let F_COLLS_After = await deftStaking.F_COLLS(collToken.address);
    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee 1 emitted in event is non-zero
    const emittedETHFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3]);
    assert.isTrue(emittedETHFee_1.gt(toBN("0")));

    const C_BalBeforeREdemption = await usddToken.balanceOf(C);
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18));

    const C_BalAfterRedemption = await usddToken.balanceOf(C);
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption));

    // check ETH fee 2 emitted in event is non-zero
    const emittedETHFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3]);
    assert.isTrue(emittedETHFee_2.gt(toBN("0")));

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawUSDD(th._100pct, dec(104, 18), D, D, {
      from: D
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_1 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_1));
    assert.isTrue(emittedUSDDFee_1.gt(toBN("0")));

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawUSDD(th._100pct, dec(17, 18), B, B, {
      from: B
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_2 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_2));
    assert.isTrue(emittedUSDDFee_2.gt(toBN("0")));

    const expectedTotalETHGain = emittedETHFee_1.add(emittedETHFee_2);
    const expectedTotalUSDDGain = emittedUSDDFee_1.add(emittedUSDDFee_2);

    const A_ETHBalance_Before = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_Before = toBN(await usddToken.balanceOf(A));

    // A un-stakes
    const unstakeTx = await deftStaking.unstake(dec(100, 18), { from: A, gasPrice: 0 });

    const A_ETHBalance_After = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_After = toBN(await usddToken.balanceOf(A));

    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before);
    const A_USDDGain = A_USDDBalance_After.sub(A_USDDBalance_Before);

    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedTotalUSDDGain, A_USDDGain), 1000);
  });

  it("stake(): Top-up sends out all accumulated ETH and USDD gains to the staker", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(50, 18), { from: A });

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee 1 emitted in event is non-zero
    const emittedETHFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3]);
    assert.isTrue(emittedETHFee_1.gt(toBN("0")));

    const C_BalBeforeREdemption = await usddToken.balanceOf(C);
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18));

    const C_BalAfterRedemption = await usddToken.balanceOf(C);
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption));

    // check ETH fee 2 emitted in event is non-zero
    const emittedETHFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3]);
    assert.isTrue(emittedETHFee_2.gt(toBN("0")));

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawUSDD(th._100pct, dec(104, 18), D, D, {
      from: D
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_1 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_1));
    assert.isTrue(emittedUSDDFee_1.gt(toBN("0")));

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawUSDD(th._100pct, dec(17, 18), B, B, {
      from: B
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_2 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_2));
    assert.isTrue(emittedUSDDFee_2.gt(toBN("0")));

    const expectedTotalETHGain = emittedETHFee_1.add(emittedETHFee_2);
    const expectedTotalUSDDGain = emittedUSDDFee_1.add(emittedUSDDFee_2);

    const A_ETHBalance_Before = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_Before = toBN(await usddToken.balanceOf(A));

    // A tops up
    await deftStaking.stake(dec(50, 18), { from: A, gasPrice: 0 });

    const A_ETHBalance_After = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_After = toBN(await usddToken.balanceOf(A));

    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before);
    const A_USDDGain = A_USDDBalance_After.sub(A_USDDBalance_Before);

    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedTotalUSDDGain, A_USDDGain), 1000);
  });

  it("getPendingCollGain(): Returns the staker's correct pending ETH gain", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(50, 18), { from: A });

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee 1 emitted in event is non-zero
    const emittedETHFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3]);
    assert.isTrue(emittedETHFee_1.gt(toBN("0")));

    const C_BalBeforeREdemption = await usddToken.balanceOf(C);
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18));

    const C_BalAfterRedemption = await usddToken.balanceOf(C);
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption));

    // check ETH fee 2 emitted in event is non-zero
    const emittedETHFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3]);
    assert.isTrue(emittedETHFee_2.gt(toBN("0")));

    const expectedTotalETHGain = emittedETHFee_1.add(emittedETHFee_2);

    const A_ETHGain = await deftStaking.getPendingCollGain(A, collToken.address);

    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000);
  });

  it("getPendingUSDDGain(): Returns the staker's correct pending USDD gain", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A
    await deftToken.transfer(A, dec(100, 18), { from: alice });

    // A makes stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftStaking.stake(dec(50, 18), { from: A });

    const B_BalBeforeREdemption = await usddToken.balanceOf(B);
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18));

    const B_BalAfterRedemption = await usddToken.balanceOf(B);
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption));

    // check ETH fee 1 emitted in event is non-zero
    const emittedETHFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3]);
    assert.isTrue(emittedETHFee_1.gt(toBN("0")));

    const C_BalBeforeREdemption = await usddToken.balanceOf(C);
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18));

    const C_BalAfterRedemption = await usddToken.balanceOf(C);
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption));

    // check ETH fee 2 emitted in event is non-zero
    const emittedETHFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3]);
    assert.isTrue(emittedETHFee_2.gt(toBN("0")));

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawUSDD(th._100pct, dec(104, 18), D, D, {
      from: D
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_1 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_1));
    assert.isTrue(emittedUSDDFee_1.gt(toBN("0")));

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawUSDD(th._100pct, dec(17, 18), B, B, {
      from: B
    });

    // Check USDD fee value in event is non-zero
    const emittedUSDDFee_2 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_2));
    assert.isTrue(emittedUSDDFee_2.gt(toBN("0")));

    const expectedTotalUSDDGain = emittedUSDDFee_1.add(emittedUSDDFee_2);
    const A_USDDGain = await deftStaking.getPendingUSDDGain(A);

    assert.isAtMost(th.getDifference(expectedTotalUSDDGain, A_USDDGain), 1000);
  });

  // - multi depositors, several rewards
  it("DEFT Staking: Multiple stakers earn the correct share of all ETH and DEFT fees, based on their stake size", async () => {
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
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: D }
    });
    await openTrove({
      extraUSDDAmount: toBN(dec(40000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: E }
    });
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: F }
    });
    await openTrove({
      extraUSDDAmount: toBN(dec(50000, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: G }
    });

    // FF time one year so owner can transfer DEFT
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

    // alice transfers DEFT to staker A, B, C
    await deftToken.transfer(A, dec(100, 18), { from: alice });
    await deftToken.transfer(B, dec(200, 18), { from: alice });
    await deftToken.transfer(C, dec(300, 18), { from: alice });

    // A, B, C make stake
    await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
    await deftToken.approve(deftStaking.address, dec(200, 18), { from: B });
    await deftToken.approve(deftStaking.address, dec(300, 18), { from: C });
    await deftStaking.stake(dec(100, 18), { from: A });
    await deftStaking.stake(dec(200, 18), { from: B });
    await deftStaking.stake(dec(300, 18), { from: C });

    // Confirm staking contract holds 600 DEFT
    // console.log(`deft staking DEFT bal: ${await deftToken.balanceOf(deftStaking.address)}`)
    assert.equal(await deftToken.balanceOf(deftStaking.address), dec(600, 18));
    assert.equal(await deftStaking.totalDEFTStaked(), dec(600, 18));

    // F redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(F, contracts, dec(45, 18));
    const emittedETHFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3]);
    assert.isTrue(emittedETHFee_1.gt(toBN("0")));

    // G redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(G, contracts, dec(197, 18));
    const emittedETHFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3]);
    assert.isTrue(emittedETHFee_2.gt(toBN("0")));

    // F draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawUSDD(th._100pct, dec(104, 18), F, F, {
      from: F
    });
    const emittedUSDDFee_1 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_1));
    assert.isTrue(emittedUSDDFee_1.gt(toBN("0")));

    // G draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawUSDD(th._100pct, dec(17, 18), G, G, {
      from: G
    });
    const emittedUSDDFee_2 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_2));
    assert.isTrue(emittedUSDDFee_2.gt(toBN("0")));

    // D obtains DEFT from owner and makes a stake
    await deftToken.transfer(D, dec(50, 18), { from: alice });
    await deftToken.approve(deftStaking.address, dec(50, 18), { from: D });
    await deftStaking.stake(dec(50, 18), { from: D });

    // Confirm staking contract holds 650 DEFT
    assert.equal(await deftToken.balanceOf(deftStaking.address), dec(650, 18));
    assert.equal(await deftStaking.totalDEFTStaked(), dec(650, 18));

    // G redeems
    const redemptionTx_3 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(197, 18));
    const emittedETHFee_3 = toBN((await th.getEmittedRedemptionValues(redemptionTx_3))[3]);
    assert.isTrue(emittedETHFee_3.gt(toBN("0")));

    // G draws debt
    const borrowingTx_3 = await borrowerOperations.withdrawUSDD(th._100pct, dec(17, 18), G, G, {
      from: G
    });
    const emittedUSDDFee_3 = toBN(th.getUSDDFeeFromUSDDBorrowingEvent(borrowingTx_3));
    assert.isTrue(emittedUSDDFee_3.gt(toBN("0")));

    /*
    Expected rewards:

    A_ETH: (100* ETHFee_1)/600 + (100* ETHFee_2)/600 + (100*ETH_Fee_3)/650
    B_ETH: (200* ETHFee_1)/600 + (200* ETHFee_2)/600 + (200*ETH_Fee_3)/650
    C_ETH: (300* ETHFee_1)/600 + (300* ETHFee_2)/600 + (300*ETH_Fee_3)/650
    D_ETH:                                             (100*ETH_Fee_3)/650

    A_USDD: (100*USDDFee_1 )/600 + (100* USDDFee_2)/600 + (100*USDDFee_3)/650
    B_USDD: (200* USDDFee_1)/600 + (200* USDDFee_2)/600 + (200*USDDFee_3)/650
    C_USDD: (300* USDDFee_1)/600 + (300* USDDFee_2)/600 + (300*USDDFee_3)/650
    D_USDD:                                               (100*USDDFee_3)/650
    */

    // Expected ETH gains
    const expectedETHGain_A = toBN("100")
      .mul(emittedETHFee_1)
      .div(toBN("600"))
      .add(toBN("100").mul(emittedETHFee_2).div(toBN("600")))
      .add(toBN("100").mul(emittedETHFee_3).div(toBN("650")));

    const expectedETHGain_B = toBN("200")
      .mul(emittedETHFee_1)
      .div(toBN("600"))
      .add(toBN("200").mul(emittedETHFee_2).div(toBN("600")))
      .add(toBN("200").mul(emittedETHFee_3).div(toBN("650")));

    const expectedETHGain_C = toBN("300")
      .mul(emittedETHFee_1)
      .div(toBN("600"))
      .add(toBN("300").mul(emittedETHFee_2).div(toBN("600")))
      .add(toBN("300").mul(emittedETHFee_3).div(toBN("650")));

    const expectedETHGain_D = toBN("50").mul(emittedETHFee_3).div(toBN("650"));

    // Expected USDD gains:
    const expectedUSDDGain_A = toBN("100")
      .mul(emittedUSDDFee_1)
      .div(toBN("600"))
      .add(toBN("100").mul(emittedUSDDFee_2).div(toBN("600")))
      .add(toBN("100").mul(emittedUSDDFee_3).div(toBN("650")));

    const expectedUSDDGain_B = toBN("200")
      .mul(emittedUSDDFee_1)
      .div(toBN("600"))
      .add(toBN("200").mul(emittedUSDDFee_2).div(toBN("600")))
      .add(toBN("200").mul(emittedUSDDFee_3).div(toBN("650")));

    const expectedUSDDGain_C = toBN("300")
      .mul(emittedUSDDFee_1)
      .div(toBN("600"))
      .add(toBN("300").mul(emittedUSDDFee_2).div(toBN("600")))
      .add(toBN("300").mul(emittedUSDDFee_3).div(toBN("650")));

    const expectedUSDDGain_D = toBN("50").mul(emittedUSDDFee_3).div(toBN("650"));

    const A_ETHBalance_Before = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_Before = toBN(await usddToken.balanceOf(A));
    const B_ETHBalance_Before = toBN(await collToken.balanceOf(B));
    const B_USDDBalance_Before = toBN(await usddToken.balanceOf(B));
    const C_ETHBalance_Before = toBN(await collToken.balanceOf(C));
    const C_USDDBalance_Before = toBN(await usddToken.balanceOf(C));
    const D_ETHBalance_Before = toBN(await collToken.balanceOf(D));
    const D_USDDBalance_Before = toBN(await usddToken.balanceOf(D));

    // A-D un-stake
    const unstake_A = await deftStaking.unstake(dec(100, 18), { from: A, gasPrice: 0 });
    const unstake_B = await deftStaking.unstake(dec(200, 18), { from: B, gasPrice: 0 });
    const unstake_C = await deftStaking.unstake(dec(400, 18), { from: C, gasPrice: 0 });
    const unstake_D = await deftStaking.unstake(dec(50, 18), { from: D, gasPrice: 0 });

    // Confirm all depositors could withdraw

    //Confirm pool Size is now 0
    assert.equal(await deftToken.balanceOf(deftStaking.address), "0");
    assert.equal(await deftStaking.totalDEFTStaked(), "0");

    // Get A-D ETH and USDD balances
    const A_ETHBalance_After = toBN(await collToken.balanceOf(A));
    const A_USDDBalance_After = toBN(await usddToken.balanceOf(A));
    const B_ETHBalance_After = toBN(await collToken.balanceOf(B));
    const B_USDDBalance_After = toBN(await usddToken.balanceOf(B));
    const C_ETHBalance_After = toBN(await collToken.balanceOf(C));
    const C_USDDBalance_After = toBN(await usddToken.balanceOf(C));
    const D_ETHBalance_After = toBN(await collToken.balanceOf(D));
    const D_USDDBalance_After = toBN(await usddToken.balanceOf(D));

    // Get ETH and USDD gains
    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before);
    const A_USDDGain = A_USDDBalance_After.sub(A_USDDBalance_Before);
    const B_ETHGain = B_ETHBalance_After.sub(B_ETHBalance_Before);
    const B_USDDGain = B_USDDBalance_After.sub(B_USDDBalance_Before);
    const C_ETHGain = C_ETHBalance_After.sub(C_ETHBalance_Before);
    const C_USDDGain = C_USDDBalance_After.sub(C_USDDBalance_Before);
    const D_ETHGain = D_ETHBalance_After.sub(D_ETHBalance_Before);
    const D_USDDGain = D_USDDBalance_After.sub(D_USDDBalance_Before);

    // Check gains match expected amounts
    assert.isAtMost(th.getDifference(expectedETHGain_A, A_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedUSDDGain_A, A_USDDGain), 1000);
    assert.isAtMost(th.getDifference(expectedETHGain_B, B_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedUSDDGain_B, B_USDDGain), 1000);
    assert.isAtMost(th.getDifference(expectedETHGain_C, C_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedUSDDGain_C, C_USDDGain), 1000);
    assert.isAtMost(th.getDifference(expectedETHGain_D, D_ETHGain), 1000);
    assert.isAtMost(th.getDifference(expectedUSDDGain_D, D_USDDGain), 1000);
  });

  // it("unstake(): reverts if caller has ETH gains and can't receive ETH", async () => {
  //   await openTrove({
  //     extraUSDDAmount: toBN(dec(20000, 18)),
  //     ICR: toBN(dec(2, 18)),
  //     extraParams: { from: whale }
  //   });
  //   await openTrove({
  //     extraUSDDAmount: toBN(dec(20000, 18)),
  //     ICR: toBN(dec(2, 18)),
  //     extraParams: { from: A }
  //   });
  //   await openTrove({
  //     extraUSDDAmount: toBN(dec(30000, 18)),
  //     ICR: toBN(dec(2, 18)),
  //     extraParams: { from: B }
  //   });
  //   await openTrove({
  //     extraUSDDAmount: toBN(dec(40000, 18)),
  //     ICR: toBN(dec(2, 18)),
  //     extraParams: { from: C }
  //   });
  //   await openTrove({
  //     extraUSDDAmount: toBN(dec(50000, 18)),
  //     ICR: toBN(dec(2, 18)),
  //     extraParams: { from: D }
  //   });

  //   await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

  //   // alice transfers DEFT to staker A and the non-payable proxy
  //   await deftToken.transfer(A, dec(100, 18), { from: alice });
  //   await deftToken.transfer(nonPayable.address, dec(100, 18), { from: alice });

  //   //  A makes stake
  //   await deftToken.approve(deftStaking.address, dec(100, 18), { from: A });
  //   const A_stakeTx = await deftStaking.stake(dec(100, 18), { from: A });
  //   assert.isTrue(A_stakeTx.receipt.status);

  //   //  A tells proxy to make a stake
  //   const proxystakeTxData = await th.getTransactionData("stake(uint256)", ["0x56bc75e2d63100000"]); // proxy stakes 100 DEFT
  //   await deftToken.approveInternal(nonPayable.address, deftStaking.address, dec(100, 18));
  //   await nonPayable.forward(deftStaking.address, proxystakeTxData, { from: A });

  //   // B makes a redemption, creating ETH gain for proxy
  //   const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(45, 18));

  //   const proxy_ETHGain = await deftStaking.getPendingCollGain(
  //     nonPayable.address,
  //     collToken.address
  //   );
  //   assert.isTrue(proxy_ETHGain.gt(toBN("0")));

  //   // Expect this tx to revert: stake() tries to send nonPayable proxy's accumulated ETH gain (albeit 0),
  //   //  A tells proxy to unstake
  //   const proxyUnStakeTxData = await th.getTransactionData("unstake(uint256)", [
  //     "0x56bc75e2d63100000"
  //   ]); // proxy stakes 100 DEFT
  //   const proxyUnstakeTxPromise = nonPayable.forward(deftStaking.address, proxyUnStakeTxData, {
  //     from: A
  //   });

  //   // but nonPayable proxy can not accept ETH - therefore stake() reverts.
  //   await assertRevert(proxyUnstakeTxPromise);
  // });

  it("receive(): reverts when it receives ETH from an address that is not the Active Pool", async () => {
    const ethSendTxPromise1 = web3.eth.sendTransaction({
      to: deftStaking.address,
      from: A,
      value: dec(1, "ether")
    });
    const ethSendTxPromise2 = web3.eth.sendTransaction({
      to: deftStaking.address,
      from: owner,
      value: dec(1, "ether")
    });

    await assertRevert(ethSendTxPromise1);
    await assertRevert(ethSendTxPromise2);
  });

  it("unstake(): reverts if user has no stake", async () => {
    const unstakeTxPromise1 = deftStaking.unstake(1, { from: A });
    const unstakeTxPromise2 = deftStaking.unstake(1, { from: owner });

    await assertRevert(unstakeTxPromise1);
    await assertRevert(unstakeTxPromise2);
  });

  it("Test requireCallerIsTroveManager", async () => {
    const deftStakingTester = await DEFTStakingTester.new();
    await assertRevert(
      deftStakingTester.requireCallerIsTroveManager(collToken.address),
      "DEFTStaking: caller is not TroveM"
    );
  });
});
