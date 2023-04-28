const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");

const { BNConverter } = require("../utils/BNConverter.js");
const TroveManagerTester = artifacts.require("TroveManagerTester");

const th = testHelpers.TestHelper;

const dec = th.dec;
const toBN = th.toBN;
const mv = testHelpers.MoneyValues;
const timeValues = testHelpers.TimeValues;

const ZERO_ADDRESS = th.ZERO_ADDRESS;
const assertRevert = th.assertRevert;
const MAX_UINT_AMOUNT = toBN(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

const {
  buildUserProxies,
  BorrowerOperationsProxy,
  BorrowerWrappersProxy,
  TroveManagerProxy,
  StabilityPoolProxy,
  SortedTrovesProxy,
  TokenProxy,
  DEFTStakingProxy
} = require("../utils/proxyHelpers.js");

contract("BorrowerWrappers", async accounts => {
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
    defaulter_1,
    defaulter_2
    // frontEnd_1, frontEnd_2, frontEnd_3
  ] = accounts;

  let priceFeed;
  let usddToken;
  let sortedTroves;
  let troveManagerOriginal;
  let troveManager;
  let activePool;
  let stabilityPool;
  let defaultPool;
  let collSurplusPool;
  let borrowerOperations;
  let borrowerWrappers;
  let deftTokenOriginal;
  let deftToken;
  let deftStakingOriginal;
  let deftStaking;
  let collToken;

  let contracts;

  let USDD_GAS_COMPENSATION;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);
  const getActualDebtFromComposite = async compositeDebt =>
    th.getActualDebtFromComposite(compositeDebt, contracts);
  const getNetBorrowingAmount = async debtWithFee =>
    th.getNetBorrowingAmount(contracts, debtWithFee);
  const openTrove = async params => th.openTrove(contracts, params);

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    contracts.troveManager = await TroveManagerTester.new();
    contracts = await deploymentHelper.deployUSDDToken(contracts);
    const DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();

    await deploymentHelper.connectDEFTContracts(DEFTContracts);
    await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
    await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

    troveManagerOriginal = contracts.troveManager;
    deftTokenOriginal = DEFTContracts.deftToken;
    deftStakingOriginal = DEFTContracts.deftStaking;

    const communityIssuance = DEFTContracts.communityIssuance;
    issuanceCap = BNConverter.makeBN18(32000000);
    deftTokenOriginal.mint(communityIssuance.address, issuanceCap);
    await communityIssuance.start(issuanceCap);

    const users = [alice, bob, carol, dennis, whale, A, B, C, D, E, defaulter_1, defaulter_2];
    await deploymentHelper.deployProxyScripts(contracts, DEFTContracts, owner, users);

    priceFeed = contracts.priceFeedTestnet;
    usddToken = contracts.usddToken;
    sortedTroves = contracts.sortedTroves;
    troveManager = contracts.troveManager;
    activePool = contracts.activePool;
    stabilityPool = contracts.stabilityPool;
    defaultPool = contracts.defaultPool;
    collSurplusPool = contracts.collSurplusPool;
    borrowerOperations = contracts.borrowerOperations;
    borrowerWrappers = contracts.borrowerWrappers;
    collToken = contracts.weth;
    deftStaking = DEFTContracts.deftStaking;
    deftToken = DEFTContracts.deftToken;

    USDD_GAS_COMPENSATION = await borrowerOperations.USDD_GAS_COMPENSATION();
  });

  it("proxy owner can recover ETH", async () => {
    const amount = toBN(dec(1, 18));
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount });
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString());

    const balanceBefore = toBN(await web3.eth.getBalance(alice));

    // recover ETH
    await borrowerWrappers.transferETH(alice, amount, { from: alice, gasPrice: 0 });
    const balanceAfter = toBN(await web3.eth.getBalance(alice));

    assert.equal(balanceAfter.sub(balanceBefore), amount.toString());
  });

  it("non proxy owner cannot recover ETH", async () => {
    const amount = toBN(dec(1, 18));
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount });
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString());

    const balanceBefore = toBN(await web3.eth.getBalance(alice));

    // try to recover ETH
    const proxy = borrowerWrappers.getProxyFromUser(alice);
    const signature = "transferETH(address,uint256)";
    const calldata = th.getTransactionData(signature, [alice, amount]);
    await assertRevert(
      proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, {
        from: bob
      }),
      "ds-auth-unauthorized"
    );

    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString());

    const balanceAfter = toBN(await web3.eth.getBalance(alice));
    assert.equal(balanceAfter, balanceBefore.toString());
  });

  // --- claimCollateralAndOpenTrove ---

  it("claimCollateralAndOpenTrove(): reverts if nothing to claim", async () => {
    // Whale opens Trove
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: whale } });

    // alice opens Trove
    const { usddAmount, collateral } = await openTrove({
      ICR: toBN(dec(15, 17)),
      extraParams: { from: alice }
    });

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);
    assert.equal(await collToken.balanceOf(proxyAddress), "0");

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // alice claims collateral and re-opens the trove
    await assertRevert(
      borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, usddAmount, alice, alice, {
        from: alice
      }),
      "CollSurplusPool: No collateral available to claim"
    );

    // check everything remain the same
    assert.equal(await collToken.balanceOf(proxyAddress), "0");
    th.assertIsApproximatelyEqual(
      await collSurplusPool.getCollateral(proxyAddress, collToken.address),
      "0"
    );
    th.assertIsApproximatelyEqual(await usddToken.balanceOf(proxyAddress), usddAmount);
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1);
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), collateral);
  });

  it("claimCollateralAndOpenTrove(): without sending any value", async () => {
    // alice opens Trove
    const { usddAmount, netDebt: redeemAmount, collateral } = await openTrove({
      extraUSDDAmount: 0,
      ICR: toBN(dec(3, 18)),
      extraParams: { from: alice }
    });
    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: redeemAmount,
      ICR: toBN(dec(5, 18)),
      extraParams: { from: whale }
    });

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);
    assert.equal(await collToken.balanceOf(proxyAddress), "0");

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 150 USDD
    await th.redeemCollateral(whale, contracts, redeemAmount);
    assert.equal(await collToken.balanceOf(proxyAddress), "0");

    // surplus: 5 - 150/200
    const price = await priceFeed.getPrice();
    const expectedSurplus = collateral.sub(redeemAmount.mul(mv._1e18BN).div(price));
    th.assertIsApproximatelyEqual(
      await collSurplusPool.getCollateral(proxyAddress, collToken.address),
      expectedSurplus
    );
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 4); // closed by redemption

    // alice claims collateral and re-opens the trove
    await borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, 0, usddAmount, alice, alice, {
      from: alice
    });

    assert.equal(await collToken.balanceOf(proxyAddress), "0");
    th.assertIsApproximatelyEqual(
      await collSurplusPool.getCollateral(proxyAddress, collToken.address),
      "0"
    );
    th.assertIsApproximatelyEqual(await usddToken.balanceOf(proxyAddress), usddAmount.mul(toBN(2)));
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1);
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), expectedSurplus);
  });

  it("claimCollateralAndOpenTrove(): sending value in the transaction", async () => {
    // alice opens Trove
    const { usddAmount, netDebt: redeemAmount, collateral } = await openTrove({
      extraParams: { from: alice }
    });
    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: redeemAmount,
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);
    assert.equal(await collToken.balanceOf(proxyAddress), "0");

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 150 USDD
    await th.redeemCollateral(whale, contracts, redeemAmount);
    assert.equal(await collToken.balanceOf(proxyAddress), "0");

    // surplus: 5 - 150/200
    const price = await priceFeed.getPrice();
    const expectedSurplus = collateral.sub(redeemAmount.mul(mv._1e18BN).div(price));
    th.assertIsApproximatelyEqual(
      await collSurplusPool.getCollateral(proxyAddress, collToken.address),
      expectedSurplus
    );
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 4); // closed by redemption

    await collToken.deposit({
      from: alice,
      value: collateral
    });
    await collToken.approve(proxyAddress, MAX_UINT_AMOUNT, {
      from: alice
    });
    // alice claims collateral and re-opens the trove
    await borrowerWrappers.claimCollateralAndOpenTrove(
      th._100pct,
      collateral,
      usddAmount,
      alice,
      alice,
      {
        from: alice
      }
    );

    assert.equal(await collToken.balanceOf(proxyAddress), "0");
    th.assertIsApproximatelyEqual(
      await collSurplusPool.getCollateral(proxyAddress, collToken.address),
      "0"
    );
    th.assertIsApproximatelyEqual(await usddToken.balanceOf(proxyAddress), usddAmount.mul(toBN(2)));
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1);
    th.assertIsApproximatelyEqual(
      await troveManager.getTroveColl(proxyAddress),
      expectedSurplus.add(collateral)
    );
  });

  // --- claimSPRewardsAndRecycle ---

  it("claimSPRewardsAndRecycle(): only owner can call it", async () => {
    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });
    // Whale deposits 1850 USDD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale });

    // alice opens trove and provides 150 USDD to StabilityPool
    await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } });
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice });

    // Defaulter Trove opened
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } });

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18));
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner });
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1);

    // Bob tries to claims SP rewards in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice);
    const signature = "claimSPRewardsAndRecycle(uint256,address,address)";
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice]);
    await assertRevert(
      proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, {
        from: bob
      }),
      "ds-auth-unauthorized"
    );
  });

  it("claimSPRewardsAndRecycle():", async () => {
    // Whale opens Trove
    const whaleDeposit = toBN(dec(2350, 18));
    await openTrove({
      extraUSDDAmount: whaleDeposit,
      ICR: toBN(dec(4, 18)),
      extraParams: { from: whale }
    });
    // Whale deposits 1850 USDD in StabilityPool
    await stabilityPool.provideToSP(whaleDeposit, ZERO_ADDRESS, { from: whale });

    // alice opens trove and provides 150 USDD to StabilityPool
    const aliceDeposit = toBN(dec(150, 18));
    await openTrove({
      extraUSDDAmount: aliceDeposit,
      ICR: toBN(dec(3, 18)),
      extraParams: { from: alice }
    });
    await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice });

    // Defaulter Trove opened
    const { usddAmount, netDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18));
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner });
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1);

    // Alice USDDLoss is ((150/2500) * liquidatedDebt)
    const totalDeposits = whaleDeposit.add(aliceDeposit);
    const expectedUSDDLoss_A = liquidatedDebt_1.mul(aliceDeposit).div(totalDeposits);

    const expectedCompoundedUSDDDeposit_A = toBN(dec(150, 18)).sub(expectedUSDDLoss_A);
    const compoundedUSDDDeposit_A = await stabilityPool.getCompoundedUSDDDeposit(alice);
    // collateral * 150 / 2500 * 0.995
    const expectedETHGain_A = collateral
      .mul(aliceDeposit)
      .div(totalDeposits)
      .mul(toBN(dec(995, 15)))
      .div(mv._1e18BN);

    assert.isAtMost(
      th.getDifference(expectedCompoundedUSDDDeposit_A, compoundedUSDDDeposit_A),
      1000
    );

    const ethBalanceBefore = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollBefore = await troveManager.getTroveColl(alice);
    const usddBalanceBefore = await usddToken.balanceOf(alice);
    const troveDebtBefore = await troveManager.getTroveDebt(alice);
    const deftBalanceBefore = await deftToken.balanceOf(alice);
    const ICRBefore = await troveManager.getCurrentICR(alice, price);
    const depositBefore = (await stabilityPool.deposits(alice))[0];
    const stakeBefore = await deftStaking.stakes(alice);

    const proportionalUSDD = expectedETHGain_A.mul(price).div(ICRBefore);
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay();
    const netDebtChange = proportionalUSDD.mul(mv._1e18BN).div(mv._1e18BN.add(borrowingRate));

    // to force DEFT issuance
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    const expectedDEFTGain_A = toBN("50373424199406504708132");

    await priceFeed.setPrice(price.mul(toBN(2)));

    // Alice claims SP rewards and puts them back in the system through the proxy
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);
    await borrowerWrappers.claimSPRewardsAndRecycle(th._100pct, alice, alice, { from: alice });

    const ethBalanceAfter = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollAfter = await troveManager.getTroveColl(alice);
    const usddBalanceAfter = await usddToken.balanceOf(alice);
    const troveDebtAfter = await troveManager.getTroveDebt(alice);
    const deftBalanceAfter = await deftToken.balanceOf(alice);
    const ICRAfter = await troveManager.getCurrentICR(alice, price);
    const depositAfter = (await stabilityPool.deposits(alice))[0];
    const stakeAfter = await deftStaking.stakes(alice);

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString());
    assert.equal(usddBalanceAfter.toString(), usddBalanceBefore.toString());
    assert.equal(deftBalanceAfter.toString(), deftBalanceBefore.toString());
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalUSDD));
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A));
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore);
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(
      depositAfter,
      depositBefore.sub(expectedUSDDLoss_A).add(netDebtChange)
    );
    // check deft balance remains the same
    th.assertIsApproximatelyEqual(deftBalanceAfter, deftBalanceBefore);

    // DEFT staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedDEFTGain_A));

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice);
    assert.equal(alice_pendingETHGain, 0);
  });

  // --- claimStakingGainsAndRecycle ---

  it("claimStakingGainsAndRecycle(): only owner can call it", async () => {
    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    // alice opens trove
    await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } });

    // mint some DEFT
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18));
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18));

    // stake DEFT
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(whale),
      deftStakingOriginal.address,
      dec(1850, 18)
    );
    await deftStaking.stake(dec(1850, 18), { from: whale });
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(alice),
      deftStakingOriginal.address,
      dec(150, 18)
    );
    await deftStaking.stake(dec(150, 18), { from: alice });

    // Defaulter Trove opened
    const { usddAmount, netDebt, totalDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 100 USDD
    const redeemedAmount = toBN(dec(100, 18));
    await th.redeemCollateral(whale, contracts, redeemedAmount);

    // Bob tries to claims staking gains in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice);
    const signature = "claimStakingGainsAndRecycle(uint256,address,address)";
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice]);
    await assertRevert(
      proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, {
        from: bob
      }),
      "ds-auth-unauthorized"
    );
  });

  it("claimStakingGainsAndRecycle(): reverts if user has no trove", async () => {
    const price = toBN(dec(200, 18));

    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });
    // Whale deposits 1850 USDD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale });

    // alice opens trove and provides 150 USDD to StabilityPool
    //await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    //await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some DEFT
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18));
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18));

    // stake DEFT
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(whale),
      deftStakingOriginal.address,
      dec(1850, 18)
    );
    await deftStaking.stake(dec(1850, 18), { from: whale });
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(alice),
      deftStakingOriginal.address,
      dec(150, 18)
    );
    await deftStaking.stake(dec(150, 18), { from: alice });

    // Defaulter Trove opened
    const { usddAmount, netDebt, totalDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });
    const borrowingFee = netDebt.sub(usddAmount);

    // Alice USDD gain is ((150/2000) * borrowingFee)
    const expectedUSDDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)));

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 100 USDD
    const redeemedAmount = toBN(dec(100, 18));
    await th.redeemCollateral(whale, contracts, redeemedAmount);

    const ethBalanceBefore = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollBefore = await troveManager.getTroveColl(alice);
    const usddBalanceBefore = await usddToken.balanceOf(alice);
    const troveDebtBefore = await troveManager.getTroveDebt(alice);
    const deftBalanceBefore = await deftToken.balanceOf(alice);
    const ICRBefore = await troveManager.getCurrentICR(alice, price);
    const depositBefore = (await stabilityPool.deposits(alice))[0];
    const stakeBefore = await deftStaking.stakes(alice);

    // Alice claims staking rewards and puts them back in the system through the proxy
    await assertRevert(
      borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice }),
      "BorrowerWrappersScript: caller must have an active trove"
    );

    const ethBalanceAfter = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollAfter = await troveManager.getTroveColl(alice);
    const usddBalanceAfter = await usddToken.balanceOf(alice);
    const troveDebtAfter = await troveManager.getTroveDebt(alice);
    const deftBalanceAfter = await deftToken.balanceOf(alice);
    const ICRAfter = await troveManager.getCurrentICR(alice, price);
    const depositAfter = (await stabilityPool.deposits(alice))[0];
    const stakeAfter = await deftStaking.stakes(alice);

    // check everything remains the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString());
    assert.equal(usddBalanceAfter.toString(), usddBalanceBefore.toString());
    assert.equal(deftBalanceAfter.toString(), deftBalanceBefore.toString());
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore, 10000);
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore);
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore);
    th.assertIsApproximatelyEqual(depositAfter, depositBefore, 10000);
    th.assertIsApproximatelyEqual(deftBalanceBefore, deftBalanceAfter);
    // DEFT staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore);

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice);
    assert.equal(alice_pendingETHGain, 0);
  });

  it("claimStakingGainsAndRecycle(): with only ETH gain", async () => {
    const price = toBN(dec(200, 18));

    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    // Defaulter Trove opened
    const { usddAmount, netDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });
    const borrowingFee = netDebt.sub(usddAmount);

    // alice opens trove and provides 150 USDD to StabilityPool
    await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } });
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice });

    // mint some DEFT
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18));
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18));

    // stake DEFT
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(whale),
      deftStakingOriginal.address,
      dec(1850, 18)
    );
    await deftStaking.stake(dec(1850, 18), { from: whale });
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(alice),
      deftStakingOriginal.address,
      dec(150, 18)
    );
    await deftStaking.stake(dec(150, 18), { from: alice });

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 100 USDD
    const redeemedAmount = toBN(dec(100, 18));
    await th.redeemCollateral(whale, contracts, redeemedAmount);

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await troveManager.getRedemptionFeeWithDecay(redeemedAmount);
    const expectedETHGain_A = redemptionFee
      .mul(toBN(dec(150, 18)))
      .div(toBN(dec(2000, 18)))
      .mul(mv._1e18BN)
      .div(price);

    const ethBalanceBefore = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollBefore = await troveManager.getTroveColl(alice);
    const usddBalanceBefore = await usddToken.balanceOf(alice);
    const troveDebtBefore = await troveManager.getTroveDebt(alice);
    const deftBalanceBefore = await deftToken.balanceOf(alice);
    const ICRBefore = await troveManager.getCurrentICR(alice, price);
    const depositBefore = (await stabilityPool.deposits(alice))[0];
    const stakeBefore = await deftStaking.stakes(alice);

    const proportionalUSDD = expectedETHGain_A.mul(price).div(ICRBefore);
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay();
    const netDebtChange = proportionalUSDD
      .mul(toBN(dec(1, 18)))
      .div(toBN(dec(1, 18)).add(borrowingRate));

    const expectedDEFTGain_A = toBN("839557069990108416000000");

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice);
    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice });

    // Alice new USDD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecay(netDebtChange);
    const expectedNewUSDDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)));

    const ethBalanceAfter = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollAfter = await troveManager.getTroveColl(alice);
    const usddBalanceAfter = await usddToken.balanceOf(alice);
    const troveDebtAfter = await troveManager.getTroveDebt(alice);
    const deftBalanceAfter = await deftToken.balanceOf(alice);
    const ICRAfter = await troveManager.getCurrentICR(alice, price);
    const depositAfter = (await stabilityPool.deposits(alice))[0];
    const stakeAfter = await deftStaking.stakes(alice);

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString());
    assert.equal(deftBalanceAfter.toString(), deftBalanceBefore.toString());
    // check proxy usdd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(usddBalanceAfter, usddBalanceBefore.add(expectedNewUSDDGain_A));
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalUSDD), 10000);
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A));
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore);
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(netDebtChange), 10000);
    // check deft balance remains the same
    th.assertIsApproximatelyEqual(deftBalanceBefore, deftBalanceAfter);

    // DEFT staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedDEFTGain_A));

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice);
    assert.equal(alice_pendingETHGain, 0);
  });

  it("claimStakingGainsAndRecycle(): with only USDD gain", async () => {
    const price = toBN(dec(200, 18));

    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    // alice opens trove and provides 150 USDD to StabilityPool
    await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } });
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice });

    // mint some DEFT
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18));
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18));

    // stake DEFT
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(whale),
      deftStakingOriginal.address,
      dec(1850, 18)
    );
    await deftStaking.stake(dec(1850, 18), { from: whale });
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(alice),
      deftStakingOriginal.address,
      dec(150, 18)
    );
    await deftStaking.stake(dec(150, 18), { from: alice });

    // Defaulter Trove opened
    const { usddAmount, netDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });
    const borrowingFee = netDebt.sub(usddAmount);

    // Alice USDD gain is ((150/2000) * borrowingFee)
    const expectedUSDDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)));

    const ethBalanceBefore = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollBefore = await troveManager.getTroveColl(alice);
    const usddBalanceBefore = await usddToken.balanceOf(alice);
    const troveDebtBefore = await troveManager.getTroveDebt(alice);
    const deftBalanceBefore = await deftToken.balanceOf(alice);
    const ICRBefore = await troveManager.getCurrentICR(alice, price);
    const depositBefore = (await stabilityPool.deposits(alice))[0];
    const stakeBefore = await deftStaking.stakes(alice);

    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay();

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice });

    const ethBalanceAfter = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollAfter = await troveManager.getTroveColl(alice);
    const usddBalanceAfter = await usddToken.balanceOf(alice);
    const troveDebtAfter = await troveManager.getTroveDebt(alice);
    const deftBalanceAfter = await deftToken.balanceOf(alice);
    const ICRAfter = await troveManager.getCurrentICR(alice, price);
    const depositAfter = (await stabilityPool.deposits(alice))[0];
    const stakeAfter = await deftStaking.stakes(alice);

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString());
    assert.equal(deftBalanceAfter.toString(), deftBalanceBefore.toString());
    // check proxy usdd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(usddBalanceAfter, usddBalanceBefore);
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore, 10000);
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore);
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore);
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedUSDDGain_A), 10000);
    // check deft balance remains the same
    th.assertIsApproximatelyEqual(deftBalanceBefore, deftBalanceAfter);

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice);
    assert.equal(alice_pendingETHGain, 0);
  });

  it("claimStakingGainsAndRecycle(): with both ETH and USDD gains", async () => {
    const price = toBN(dec(200, 18));

    // Whale opens Trove
    await openTrove({
      extraUSDDAmount: toBN(dec(1850, 18)),
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    // alice opens trove and provides 150 USDD to StabilityPool
    await openTrove({ extraUSDDAmount: toBN(dec(150, 18)), extraParams: { from: alice } });
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice });

    // mint some DEFT
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18));
    await deftTokenOriginal.mint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18));

    // stake DEFT
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(whale),
      deftStakingOriginal.address,
      dec(1850, 18)
    );
    await deftStaking.stake(dec(1850, 18), { from: whale });
    await deftTokenOriginal.approveInternal(
      borrowerOperations.getProxyAddressFromUser(alice),
      deftStakingOriginal.address,
      dec(150, 18)
    );
    await deftStaking.stake(dec(150, 18), { from: alice });

    // Defaulter Trove opened
    const { usddAmount, netDebt, collateral } = await openTrove({
      ICR: toBN(dec(210, 16)),
      extraParams: { from: defaulter_1 }
    });
    const borrowingFee = netDebt.sub(usddAmount);

    // Alice USDD gain is ((150/2000) * borrowingFee)
    const expectedUSDDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)));

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    // whale redeems 100 USDD
    const redeemedAmount = toBN(dec(100, 18));
    await th.redeemCollateral(whale, contracts, redeemedAmount);

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await troveManager.getRedemptionFeeWithDecay(redeemedAmount);
    const expectedETHGain_A = redemptionFee
      .mul(toBN(dec(150, 18)))
      .div(toBN(dec(2000, 18)))
      .mul(mv._1e18BN)
      .div(price);

    const ethBalanceBefore = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollBefore = await troveManager.getTroveColl(alice);
    const usddBalanceBefore = await usddToken.balanceOf(alice);
    const troveDebtBefore = await troveManager.getTroveDebt(alice);
    const deftBalanceBefore = await deftToken.balanceOf(alice);
    const ICRBefore = await troveManager.getCurrentICR(alice, price);
    const depositBefore = (await stabilityPool.deposits(alice))[0];
    const stakeBefore = await deftStaking.stakes(alice);

    const proportionalUSDD = expectedETHGain_A.mul(price).div(ICRBefore);
    const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay();
    const netDebtChange = proportionalUSDD
      .mul(toBN(dec(1, 18)))
      .div(toBN(dec(1, 18)).add(borrowingRate));
    const expectedTotalUSDD = expectedUSDDGain_A.add(netDebtChange);

    const expectedDEFTGain_A = toBN("839557069990108416000000");

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice });

    // Alice new USDD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecay(netDebtChange);
    const expectedNewUSDDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)));

    const ethBalanceAfter = await collToken.balanceOf(
      borrowerOperations.getProxyAddressFromUser(alice)
    );
    const troveCollAfter = await troveManager.getTroveColl(alice);
    const usddBalanceAfter = await usddToken.balanceOf(alice);
    const troveDebtAfter = await troveManager.getTroveDebt(alice);
    const deftBalanceAfter = await deftToken.balanceOf(alice);
    const ICRAfter = await troveManager.getCurrentICR(alice, price);
    const depositAfter = (await stabilityPool.deposits(alice))[0];
    const stakeAfter = await deftStaking.stakes(alice);

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString());
    assert.equal(deftBalanceAfter.toString(), deftBalanceBefore.toString());
    // check proxy usdd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(usddBalanceAfter, usddBalanceBefore.add(expectedNewUSDDGain_A));
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalUSDD), 10000);
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A));
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore);
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedTotalUSDD), 10000);
    // check deft balance remains the same
    th.assertIsApproximatelyEqual(deftBalanceBefore, deftBalanceAfter);

    // DEFT staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedDEFTGain_A));

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorETHGain(alice);
    assert.equal(alice_pendingETHGain, 0);
  });
});
