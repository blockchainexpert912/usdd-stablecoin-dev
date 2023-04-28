const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");
const { BNConverter } = require("../utils/BNConverter.js");

const th = testHelpers.TestHelper;
const timeValues = testHelpers.TimeValues;
const dec = th.dec;
const toBN = th.toBN;
const getDifference = th.getDifference;

const TroveManagerTester = artifacts.require("TroveManagerTester");
const USDDToken = artifacts.require("USDDToken");

contract("StabilityPool - DEFT Rewards", async accounts => {
  const [
    owner,
    whale,
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    defaulter_1,
    defaulter_2,
    defaulter_3,
    defaulter_4,
    defaulter_5,
    defaulter_6,
    frontEnd_1,
    frontEnd_2,
    frontEnd_3
  ] = accounts;

  let contracts;

  let priceFeed;
  let usddToken;
  let stabilityPool;
  let sortedTroves;
  let troveManager;
  let borrowerOperations;
  let deftToken;
  let communityIssuanceTester;

  let communityDEFTSupply;
  let issuance_M1;
  let issuance_M2;
  let issuance_M3;
  let issuance_M4;
  let issuance_M5;
  let issuance_M6;

  const ZERO_ADDRESS = th.ZERO_ADDRESS;

  const getOpenTroveUSDDAmount = async totalDebt => th.getOpenTroveUSDDAmount(contracts, totalDebt);

  const openTrove = async params => th.openTrove(contracts, params);
  describe("DEFT Rewards", async () => {
    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore();
      contracts.troveManager = await TroveManagerTester.new();
      contracts.usddToken = await USDDToken.new(
        contracts.troveManager.address,
        contracts.stabilityPool.address,
        contracts.borrowerOperations.address
      );
      const DEFTContracts = await deploymentHelper.deployDEFTTesterContractsHardhat();

      priceFeed = contracts.priceFeedTestnet;
      usddToken = contracts.usddToken;
      stabilityPool = contracts.stabilityPool;
      sortedTroves = contracts.sortedTroves;
      troveManager = contracts.troveManager;
      stabilityPool = contracts.stabilityPool;
      borrowerOperations = contracts.borrowerOperations;

      deftToken = DEFTContracts.deftToken;
      communityIssuanceTester = DEFTContracts.communityIssuance;

      await deploymentHelper.connectDEFTContracts(DEFTContracts);
      await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
      await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);

      issuanceCap = BNConverter.makeBN18(32000000);
      deftToken.mint(communityIssuanceTester.address, issuanceCap);
      await communityIssuanceTester.start(issuanceCap);

      // Check community issuance starts with 32 million DEFT
      communityDEFTSupply = toBN(await deftToken.balanceOf(communityIssuanceTester.address));
      assert.isAtMost(getDifference(communityDEFTSupply, "32000000000000000000000000"), 1000);

      /* Monthly DEFT issuance
  
        Expected fraction of total supply issued per month, for a yearly halving schedule
        (issuance in each month, not cumulative):
    
        Month 1: 0.055378538087966600
        Month 2: 0.052311755607206100
        Month 3: 0.049414807056864200
        Month 4: 0.046678287282156100
        Month 5: 0.044093311972020200
        Month 6: 0.041651488815552900
      */

      issuance_M1 = toBN("55378538087966600")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
      issuance_M2 = toBN("52311755607206100")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
      issuance_M3 = toBN("49414807056864200")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
      issuance_M4 = toBN("46678287282156100")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
      issuance_M5 = toBN("44093311972020200")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
      issuance_M6 = toBN("41651488815552900")
        .mul(communityDEFTSupply)
        .div(toBN(dec(1, 18)));
    });

    it("liquidation < 1 minute after a deposit does not change totalDEFTIssued", async () => {
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: A }
      });
      await openTrove({
        extraUSDDAmount: toBN(dec(10000, 18)),
        ICR: toBN(dec(2, 18)),
        extraParams: { from: B }
      });

      // A, B provide to SP
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });
      await stabilityPool.provideToSP(dec(5000, 18), ZERO_ADDRESS, { from: B });

      await th.fastForwardTime(timeValues.MINUTES_IN_ONE_WEEK, web3.currentProvider);

      await priceFeed.setPrice(dec(105, 18));

      // B adjusts, triggering DEFT issuance for all
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: B });
      const blockTimestamp_1 = th.toBN(await th.getLatestBlockTimestamp(web3));

      // Check DEFT has been issued
      const totalDEFTIssued_1 = await communityIssuanceTester.totalDEFTIssued();
      assert.isTrue(totalDEFTIssued_1.gt(toBN("0")));

      await troveManager.liquidate(B);
      const blockTimestamp_2 = th.toBN(await th.getLatestBlockTimestamp(web3));

      assert.isFalse(await sortedTroves.contains(B));

      const totalDEFTIssued_2 = await communityIssuanceTester.totalDEFTIssued();

      console.log(`totalDEFTIssued_1: ${totalDEFTIssued_1}`);
      console.log(`totalDEFTIssued_2: ${totalDEFTIssued_2}`);

      // check blockTimestamp diff < 60s
      const timestampDiff = blockTimestamp_2.sub(blockTimestamp_1);
      assert.isTrue(timestampDiff.lt(toBN(60)));

      // Check that the liquidation did not alter total DEFT issued
      assert.isTrue(totalDEFTIssued_2.eq(totalDEFTIssued_1));

      // Check that depositor B has no DEFT gain
      const B_pendingDEFTGain = await stabilityPool.getDepositorDEFTGain(B);
      assert.equal(B_pendingDEFTGain, "0");

      // Check depositor B has a pending ETH gain
      const B_pendingETHGain = await stabilityPool.getDepositorCollGain(B);
      assert.isTrue(B_pendingETHGain.gt(toBN("0")));
    });

    it("withdrawFromSP(): reward term G does not update when no DEFT is issued", async () => {
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(1000, "ether")) }
      });

      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });

      const A_initialDeposit = (await stabilityPool.deposits(A))[0].toString();
      assert.equal(A_initialDeposit, dec(10000, 18));

      // defaulter opens trove
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: { from: defaulter_1, value: toBN(dec(100, "ether")) }
      });

      // ETH drops
      await priceFeed.setPrice(dec(100, 18));

      await th.fastForwardTime(timeValues.MINUTES_IN_ONE_WEEK, web3.currentProvider);

      // Liquidate d1. Triggers issuance.
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      // Get G and communityIssuance before
      const G_Before = await stabilityPool.epochToScaleToG(0, 0);
      const DEFTIssuedBefore = await communityIssuanceTester.totalDEFTIssued();

      //  A withdraws some deposit. Triggers issuance.
      const tx = await stabilityPool.withdrawFromSP(1000, { from: A, gasPrice: 0 });
      assert.isTrue(tx.receipt.status);

      // Check G and DEFTIssued do not increase, since <1 minute has passed between issuance triggers
      const G_After = await stabilityPool.epochToScaleToG(0, 0);
      const DEFTIssuedAfter = await communityIssuanceTester.totalDEFTIssued();

      assert.isTrue(G_After.eq(G_Before));
      assert.isTrue(DEFTIssuedAfter.eq(DEFTIssuedBefore));
    });

    // using the result of this to advance time by the desired amount from the deployment time, whether or not some extra time has passed in the meanwhile
    const getDuration = async expectedDuration => {
      const startTime = (await communityIssuanceTester.startTime()).toNumber();
      const currentTime = await th.getLatestBlockTimestamp(web3);
      const duration = Math.max(expectedDuration - (currentTime - startTime), 0);

      return duration;
    };

    // Simple case: 3 depositors, equal stake. No liquidations. No front-end.
    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct DEFT gain. No liquidations. No front end.", async () => {
      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(1, 22)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(1, 22)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(1, 22)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(1, 22)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(100, "ether")) }
      });

      // Check all DEFT balances are initially 0
      assert.equal(await deftToken.balanceOf(A), 0);
      assert.equal(await deftToken.balanceOf(B), 0);
      assert.equal(await deftToken.balanceOf(C), 0);

      // A, B, C deposit
      await stabilityPool.provideToSP(dec(1, 22), ZERO_ADDRESS, { from: A });
      await stabilityPool.provideToSP(dec(1, 22), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(1, 22), ZERO_ADDRESS, { from: C });

      // One year passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_YEAR),
        web3.currentProvider
      );

      // D deposits, triggering DEFT gains for A,B,C. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: D });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: D });

      // Expected gains for each depositor after 1 year (50% total issued).  Each deposit gets 1/3 of issuance.
      const expectedDEFTGain_1yr = communityDEFTSupply.div(toBN("2")).div(toBN("3"));

      // Check DEFT gain
      const A_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(C);

      // Check gains are correct, error tolerance = 1e-6 of a token

      assert.isAtMost(getDifference(A_DEFTGain_1yr, expectedDEFTGain_1yr), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_1yr, expectedDEFTGain_1yr), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_1yr, expectedDEFTGain_1yr), 1e12);

      // Another year passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

      // D deposits, triggering DEFT gains for A,B,C. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: D });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: D });

      // Expected gains for each depositor after 2 years (75% total issued).  Each deposit gets 1/3 of issuance.
      const expectedDEFTGain_2yr = communityDEFTSupply.mul(toBN("3")).div(toBN("4")).div(toBN("3"));

      // Check DEFT gain
      const A_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(C);

      // Check gains are correct, error tolerance = 1e-6 of a token
      assert.isAtMost(getDifference(A_DEFTGain_2yr, expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_2yr, expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_2yr, expectedDEFTGain_2yr), 1e12);

      // Each depositor fully withdraws
      await stabilityPool.withdrawFromSP(dec(100, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(100, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(100, 18), { from: C });

      // Check DEFT balances increase by correct amount
      assert.isAtMost(getDifference(await deftToken.balanceOf(A), expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(B), expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(C), expectedDEFTGain_2yr), 1e12);
    });

    // 3 depositors, varied stake. No liquidations. No front-end.
    it("withdrawFromSP(): Depositors with varying initial deposit withdraw correct DEFT gain. No liquidations. No front end.", async () => {
      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(300, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(30000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(400, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(100, "ether")) }
      });

      // Check all DEFT balances are initially 0
      assert.equal(await deftToken.balanceOf(A), 0);
      assert.equal(await deftToken.balanceOf(B), 0);
      assert.equal(await deftToken.balanceOf(C), 0);

      // A, B, C deposit
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), ZERO_ADDRESS, { from: C });

      // One year passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_YEAR),
        web3.currentProvider
      );

      // D deposits, triggering DEFT gains for A,B,C. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: D });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: D });

      // Expected gains for each depositor after 1 year (50% total issued)
      const A_expectedDEFTGain_1yr = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued after 1 year
        .div(toBN("6")); // A gets 1/6 of the issuance

      const B_expectedDEFTGain_1yr = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued after 1 year
        .div(toBN("3")); // B gets 2/6 = 1/3 of the issuance

      const C_expectedDEFTGain_1yr = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued after 1 year
        .div(toBN("2")); // C gets 3/6 = 1/2 of the issuance

      // Check DEFT gain
      const A_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_1yr = await stabilityPool.getDepositorDEFTGain(C);

      // Check gains are correct, error tolerance = 1e-6 of a toke
      assert.isAtMost(getDifference(A_DEFTGain_1yr, A_expectedDEFTGain_1yr), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_1yr, B_expectedDEFTGain_1yr), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_1yr, C_expectedDEFTGain_1yr), 1e12);

      // Another year passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

      // D deposits, triggering DEFT gains for A,B,C. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: D });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: D });

      // Expected gains for each depositor after 2 years (75% total issued).
      const A_expectedDEFTGain_2yr = communityDEFTSupply
        .mul(toBN("3"))
        .div(toBN("4")) // 75% of total issued after 1 year
        .div(toBN("6")); // A gets 1/6 of the issuance

      const B_expectedDEFTGain_2yr = communityDEFTSupply
        .mul(toBN("3"))
        .div(toBN("4")) // 75% of total issued after 1 year
        .div(toBN("3")); // B gets 2/6 = 1/3 of the issuance

      const C_expectedDEFTGain_2yr = communityDEFTSupply
        .mul(toBN("3"))
        .div(toBN("4")) // 75% of total issued after 1 year
        .div(toBN("2")); // C gets 3/6 = 1/2 of the issuance

      // Check DEFT gain
      const A_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_2yr = await stabilityPool.getDepositorDEFTGain(C);

      // Check gains are correct, error tolerance = 1e-6 of a token
      assert.isAtMost(getDifference(A_DEFTGain_2yr, A_expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_2yr, B_expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_2yr, C_expectedDEFTGain_2yr), 1e12);

      // Each depositor fully withdraws
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: C });

      // Check DEFT balances increase by correct amount
      assert.isAtMost(getDifference(await deftToken.balanceOf(A), A_expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(B), B_expectedDEFTGain_2yr), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(C), C_expectedDEFTGain_2yr), 1e12);
    });

    // A, B, C deposit. Varied stake. 1 Liquidation. D joins.
    it("withdrawFromSP(): Depositors with varying initial deposit withdraw correct DEFT gain. No liquidations. No front end.", async () => {
      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(200, "ether")) }
      });
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(300, "ether")) }
      });
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(30000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(400, "ether")) }
      });
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(40000, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(500, "ether")) }
      });
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(40000, 18)),
        upperHint: E,
        lowerHint: E,
        extraParams: { from: E, value: toBN(dec(600, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(30000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: { from: defaulter_1, value: toBN(dec(300, "ether")) }
      });

      // Check all DEFT balances are initially 0
      assert.equal(await deftToken.balanceOf(A), 0);
      assert.equal(await deftToken.balanceOf(B), 0);
      assert.equal(await deftToken.balanceOf(C), 0);
      assert.equal(await deftToken.balanceOf(D), 0);

      // A, B, C deposit
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), ZERO_ADDRESS, { from: C });

      // Year 1 passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_YEAR),
        web3.currentProvider
      );

      assert.equal(await stabilityPool.getTotalUSDDDeposits(), dec(60000, 18));

      // Price Drops, defaulter1 liquidated. Stability Pool size drops by 50%
      await priceFeed.setPrice(dec(100, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      // Confirm SP dropped from 60k to 30k
      assert.isAtMost(
        getDifference(await stabilityPool.getTotalUSDDDeposits(), dec(30000, 18)),
        1000
      );

      // Expected gains for each depositor after 1 year (50% total issued)
      const A_expectedDEFTGain_Y1 = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued in Y1
        .div(toBN("6")); // A got 1/6 of the issuance

      const B_expectedDEFTGain_Y1 = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued in Y1
        .div(toBN("3")); // B gets 2/6 = 1/3 of the issuance

      const C_expectedDEFTGain_Y1 = communityDEFTSupply
        .div(toBN("2")) // 50% of total issued in Y1
        .div(toBN("2")); // C gets 3/6 = 1/2 of the issuance

      // Check DEFT gain
      const A_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(C);

      // Check gains are correct, error tolerance = 1e-6 of a toke
      assert.isAtMost(getDifference(A_DEFTGain_Y1, A_expectedDEFTGain_Y1), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_Y1, B_expectedDEFTGain_Y1), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_Y1, C_expectedDEFTGain_Y1), 1e12);

      // D deposits 40k
      await stabilityPool.provideToSP(dec(40000, 18), ZERO_ADDRESS, { from: D });

      // Year 2 passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

      // E deposits and withdraws, creating DEFT issuance
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: E });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: E });

      // Expected gains for each depositor during Y2:
      const A_expectedDEFTGain_Y2 = communityDEFTSupply
        .div(toBN("4")) // 25% of total issued in Y2
        .div(toBN("14")); // A got 50/700 = 1/14 of the issuance

      const B_expectedDEFTGain_Y2 = communityDEFTSupply
        .div(toBN("4")) // 25% of total issued in Y2
        .div(toBN("7")); // B got 100/700 = 1/7 of the issuance

      const C_expectedDEFTGain_Y2 = communityDEFTSupply
        .div(toBN("4")) // 25% of total issued in Y2
        .mul(toBN("3"))
        .div(toBN("14")); // C gets 150/700 = 3/14 of the issuance

      const D_expectedDEFTGain_Y2 = communityDEFTSupply
        .div(toBN("4")) // 25% of total issued in Y2
        .mul(toBN("4"))
        .div(toBN("7")); // D gets 400/700 = 4/7 of the issuance

      // Check DEFT gain
      const A_DEFTGain_AfterY2 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_AfterY2 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_AfterY2 = await stabilityPool.getDepositorDEFTGain(C);
      const D_DEFTGain_AfterY2 = await stabilityPool.getDepositorDEFTGain(D);

      const A_expectedTotalGain = A_expectedDEFTGain_Y1.add(A_expectedDEFTGain_Y2);
      const B_expectedTotalGain = B_expectedDEFTGain_Y1.add(B_expectedDEFTGain_Y2);
      const C_expectedTotalGain = C_expectedDEFTGain_Y1.add(C_expectedDEFTGain_Y2);
      const D_expectedTotalGain = D_expectedDEFTGain_Y2;

      // Check gains are correct, error tolerance = 1e-6 of a token
      assert.isAtMost(getDifference(A_DEFTGain_AfterY2, A_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_AfterY2, B_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_AfterY2, C_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(D_DEFTGain_AfterY2, D_expectedTotalGain), 1e12);

      // Each depositor fully withdraws
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(20000, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(30000, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(40000, 18), { from: D });

      // Check DEFT balances increase by correct amount
      assert.isAtMost(getDifference(await deftToken.balanceOf(A), A_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(B), B_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(C), C_expectedTotalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(D), D_expectedTotalGain), 1e12);
    });

    //--- Serial pool-emptying liquidations ---

    /* A, B deposit 100C
    L1 cancels 200C
    B, C deposits 100C
    L2 cancels 200C
    E, F deposit 100C
    L3 cancels 200C
    G,H deposits 100C
    L4 cancels 200C

    Expect all depositors withdraw  1/2 of 1 month's DEFT issuance */
    it("withdrawFromSP(): Depositor withdraws correct DEFT gain after serial pool-emptying liquidations. No front-ends.", async () => {
      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      const allDepositors = [A, B, C, D, E, F, G, H];
      // 4 Defaulters open trove with 200USDD debt, and 200% ICR
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: { from: defaulter_1, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: defaulter_2,
        lowerHint: defaulter_2,
        extraParams: { from: defaulter_2, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: defaulter_3,
        lowerHint: defaulter_3,
        extraParams: { from: defaulter_3, value: toBN(dec(200, "ether")) }
      });
      ``;
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(20000, 18)),
        upperHint: defaulter_4,
        lowerHint: defaulter_4,
        extraParams: { from: defaulter_4, value: toBN(dec(200, "ether")) }
      });

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Check all would-be depositors have 0 DEFT balance
      for (depositor of allDepositors) {
        assert.equal(await deftToken.balanceOf(depositor), "0");
      }

      // A, B each deposit 10k USDD
      const depositors_1 = [A, B];
      for (account of depositors_1) {
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: toBN(dec(10000, 18)),
          upperHint: account,
          lowerHint: account,
          extraParams: { from: account, value: toBN(dec(200, "ether")) }
        });
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account });
      }

      // 1 month passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_MONTH),
        web3.currentProvider
      );

      // Defaulter 1 liquidated. 20k USDD fully offset with pool.
      await troveManager.liquidate(defaulter_1, { from: owner });

      // C, D each deposit 10k USDD
      const depositors_2 = [C, D];
      for (account of depositors_2) {
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: toBN(dec(10000, 18)),
          upperHint: account,
          lowerHint: account,
          extraParams: { from: account, value: toBN(dec(200, "ether")) }
        });
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account });
      }

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 2 liquidated. 10k USDD offset
      await troveManager.liquidate(defaulter_2, { from: owner });

      // Erin, Flyn each deposit 100 USDD
      const depositors_3 = [E, F];
      for (account of depositors_3) {
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: toBN(dec(10000, 18)),
          upperHint: account,
          lowerHint: account,
          extraParams: { from: account, value: toBN(dec(200, "ether")) }
        });
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account });
      }

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 3 liquidated. 100 USDD offset
      await troveManager.liquidate(defaulter_3, { from: owner });

      // Graham, Harriet each deposit 10k USDD
      const depositors_4 = [G, H];
      for (account of depositors_4) {
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: toBN(dec(10000, 18)),
          upperHint: account,
          lowerHint: account,
          extraParams: { from: account, value: toBN(dec(200, "ether")) }
        });
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account });
      }

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 4 liquidated. 100 USDD offset
      await troveManager.liquidate(defaulter_4, { from: owner });

      // All depositors withdraw from SP
      for (depositor of allDepositors) {
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: depositor });
      }

      /* Each depositor constitutes 50% of the pool from the time they deposit, up until the liquidation.
      Therefore, divide monthly issuance by 2 to get the expected per-depositor DEFT gain.*/
      const expectedDEFTGain_M1 = issuance_M1.div(th.toBN("2"));
      const expectedDEFTGain_M2 = issuance_M2.div(th.toBN("2"));
      const expectedDEFTGain_M3 = issuance_M3.div(th.toBN("2"));
      const expectedDEFTGain_M4 = issuance_M4.div(th.toBN("2"));

      // Check A, B only earn issuance from month 1. Error tolerance = 1e-3 tokens
      for (depositor of [A, B]) {
        const DEFTBalance = await deftToken.balanceOf(depositor);
        assert.isAtMost(getDifference(DEFTBalance, expectedDEFTGain_M1), 1e15);
      }

      // Check C, D only earn issuance from month 2.  Error tolerance = 1e-3 tokens
      for (depositor of [C, D]) {
        const DEFTBalance = await deftToken.balanceOf(depositor);
        assert.isAtMost(getDifference(DEFTBalance, expectedDEFTGain_M2), 1e15);
      }

      // Check E, F only earn issuance from month 3.  Error tolerance = 1e-3 tokens
      for (depositor of [E, F]) {
        const DEFTBalance = await deftToken.balanceOf(depositor);
        assert.isAtMost(getDifference(DEFTBalance, expectedDEFTGain_M3), 1e15);
      }

      // Check G, H only earn issuance from month 4.  Error tolerance = 1e-3 tokens
      for (depositor of [G, H]) {
        const DEFTBalance = await deftToken.balanceOf(depositor);
        assert.isAtMost(getDifference(DEFTBalance, expectedDEFTGain_M4), 1e15);
      }

      const finalEpoch = (await stabilityPool.currentEpoch()).toString();
      assert.equal(finalEpoch, 4);
    });

    it("DEFT issuance for a given period is not obtainable if the SP was empty during the period", async () => {
      const CIBalanceBefore = await deftToken.balanceOf(communityIssuanceTester.address);
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(16000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(16000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(200, "ether")) }
      });

      const totalDEFTissuance_0 = await communityIssuanceTester.totalDEFTIssued();
      const G_0 = await stabilityPool.epochToScaleToG(0, 0); // epochs and scales will not change in this test: no liquidations
      assert.equal(totalDEFTissuance_0, "0");
      assert.equal(G_0, "0");

      // 1 month passes (M1)
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_MONTH),
        web3.currentProvider
      );

      // DEFT issuance event triggered: A deposits
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });

      // Check G is not updated, since SP was empty prior to A's deposit
      const G_1 = await stabilityPool.epochToScaleToG(0, 0);
      assert.isTrue(G_1.eq(G_0));

      // Check total DEFT issued is updated
      const totalDEFTissuance_1 = await communityIssuanceTester.totalDEFTIssued();
      assert.isTrue(totalDEFTissuance_1.gt(totalDEFTissuance_0));

      // 1 month passes (M2)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      //DEFT issuance event triggered: A withdraws.
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });

      // Check G is updated, since SP was not empty prior to A's withdrawal
      const G_2 = await stabilityPool.epochToScaleToG(0, 0);
      assert.isTrue(G_2.gt(G_1));

      // Check total DEFT issued is updated
      const totalDEFTissuance_2 = await communityIssuanceTester.totalDEFTIssued();
      assert.isTrue(totalDEFTissuance_2.gt(totalDEFTissuance_1));

      // 1 month passes (M3)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // DEFT issuance event triggered: C deposits
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: C });

      // Check G is not updated, since SP was empty prior to C's deposit
      const G_3 = await stabilityPool.epochToScaleToG(0, 0);
      assert.isTrue(G_3.eq(G_2));

      // Check total DEFT issued is updated
      const totalDEFTissuance_3 = await communityIssuanceTester.totalDEFTIssued();
      assert.isTrue(totalDEFTissuance_3.gt(totalDEFTissuance_2));

      // 1 month passes (M4)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // C withdraws
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: C });

      // Check G is increased, since SP was not empty prior to C's withdrawal
      const G_4 = await stabilityPool.epochToScaleToG(0, 0);
      assert.isTrue(G_4.gt(G_3));

      // Check total DEFT issued is increased
      const totalDEFTissuance_4 = await communityIssuanceTester.totalDEFTIssued();
      assert.isTrue(totalDEFTissuance_4.gt(totalDEFTissuance_3));

      // Get DEFT Gains
      const A_DEFTGain = await deftToken.balanceOf(A);
      const C_DEFTGain = await deftToken.balanceOf(C);

      // Check A earns gains from M2 only
      assert.isAtMost(getDifference(A_DEFTGain, issuance_M2), 1e15);

      // Check C earns gains from M4 only
      assert.isAtMost(getDifference(C_DEFTGain, issuance_M4), 1e15);

      // Check totalDEFTIssued = M1 + M2 + M3 + M4.  1e-3 error tolerance.
      const expectedIssuance4Months = issuance_M1.add(issuance_M2).add(issuance_M3).add(issuance_M4);
      assert.isAtMost(getDifference(expectedIssuance4Months, totalDEFTissuance_4), 1e15);

      // Check CI has only transferred out tokens for M2 + M4.  1e-3 error tolerance.
      const expectedDEFTSentOutFromCI = issuance_M2.add(issuance_M4);
      const CIBalanceAfter = await deftToken.balanceOf(communityIssuanceTester.address);
      const CIBalanceDifference = CIBalanceBefore.sub(CIBalanceAfter);
      assert.isAtMost(getDifference(CIBalanceDifference, expectedDEFTSentOutFromCI), 1e15);
    });

    // --- Scale factor changes ---

    /* Serial scale changes

    A make deposit 10k USDD
    1 month passes. L1 decreases P: P = 1e-5 P. L1:   9999.9 USDD, 100 ETH
    B makes deposit 9999.9
    1 month passes. L2 decreases P: P =  1e-5 P. L2:  9999.9 USDD, 100 ETH
    C makes deposit  9999.9
    1 month passes. L3 decreases P: P = 1e-5 P. L3:  9999.9 USDD, 100 ETH
    D makes deposit  9999.9
    1 month passes. L4 decreases P: P = 1e-5 P. L4:  9999.9 USDD, 100 ETH
    E makes deposit  9999.9
    1 month passes. L5 decreases P: P = 1e-5 P. L5:  9999.9 USDD, 100 ETH
    =========
    F makes deposit 100
    1 month passes. L6 empties the Pool. L6:  10000 USDD, 100 ETH

    expect A, B, C, D each withdraw ~1 month's worth of DEFT */
    it("withdrawFromSP(): Several deposits of 100 USDD span one scale factor change. Depositors withdraw correct DEFT gains", async () => {
      // Whale opens Trove with 100 ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(100, "ether")) }
      });

      const fiveDefaulters = [defaulter_1, defaulter_2, defaulter_3, defaulter_4, defaulter_5];
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(10000, "ether")) }
      });
      ``;
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: E,
        lowerHint: E,
        extraParams: { from: E, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: F,
        lowerHint: F,
        extraParams: { from: F, value: toBN(dec(10000, "ether")) }
      });

      for (const defaulter of fiveDefaulters) {
        // Defaulters 1-5 each withdraw to 9999.9 debt (including gas comp)

        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: await getOpenTroveUSDDAmount("9999900000000000000000"),
          upperHint: defaulter,
          lowerHint: defaulter,
          extraParams: { from: defaulter, value: toBN(dec(100, "ether")) }
        });
      }

      // Defaulter 6 withdraws to 10k debt (inc. gas comp)
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: defaulter_6,
        lowerHint: defaulter_6,
        extraParams: { from: defaulter_6, value: toBN(dec(100, "ether")) }
      });

      // Confirm all depositors have 0 DEFT
      for (const depositor of [A, B, C, D, E, F]) {
        assert.equal(await deftToken.balanceOf(depositor), "0");
      }
      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Check scale is 0
      // assert.equal(await stabilityPool.currentScale(), '0')

      // A provides to SP
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A });

      // 1 month passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_MONTH),
        web3.currentProvider
      );

      // Defaulter 1 liquidated.  Value of P updated to  to 1e-5
      const txL1 = await troveManager.liquidate(defaulter_1, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isTrue(txL1.receipt.status);

      // Check scale is 0
      assert.equal(await stabilityPool.currentScale(), "0");
      assert.equal(await stabilityPool.P(), dec(1, 13)); //P decreases: P = 1e(18-5) = 1e13

      // B provides to SP
      await stabilityPool.provideToSP(dec(99999, 17), ZERO_ADDRESS, { from: B });

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 2 liquidated
      const txL2 = await troveManager.liquidate(defaulter_2, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_2));
      assert.isTrue(txL2.receipt.status);

      // Check scale is 1
      assert.equal(await stabilityPool.currentScale(), "1");
      assert.equal(await stabilityPool.P(), dec(1, 17)); //Scale changes and P changes: P = 1e(13-5+9) = 1e17

      // C provides to SP
      await stabilityPool.provideToSP(dec(99999, 17), ZERO_ADDRESS, { from: C });

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 3 liquidated
      const txL3 = await troveManager.liquidate(defaulter_3, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_3));
      assert.isTrue(txL3.receipt.status);

      // Check scale is 1
      assert.equal(await stabilityPool.currentScale(), "1");
      assert.equal(await stabilityPool.P(), dec(1, 12)); //P decreases: P 1e(17-5) = 1e12

      // D provides to SP
      await stabilityPool.provideToSP(dec(99999, 17), ZERO_ADDRESS, { from: D });

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 4 liquidated
      const txL4 = await troveManager.liquidate(defaulter_4, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_4));
      assert.isTrue(txL4.receipt.status);

      // Check scale is 2
      assert.equal(await stabilityPool.currentScale(), "2");
      assert.equal(await stabilityPool.P(), dec(1, 16)); //Scale changes and P changes:: P = 1e(12-5+9) = 1e16

      // E provides to SP
      await stabilityPool.provideToSP(dec(99999, 17), ZERO_ADDRESS, { from: E });

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 5 liquidated
      const txL5 = await troveManager.liquidate(defaulter_5, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_5));
      assert.isTrue(txL5.receipt.status);

      // Check scale is 2
      assert.equal(await stabilityPool.currentScale(), "2");
      assert.equal(await stabilityPool.P(), dec(1, 11)); // P decreases: P = 1e(16-5) = 1e11

      // F provides to SP
      await stabilityPool.provideToSP(dec(99999, 17), ZERO_ADDRESS, { from: F });

      // 1 month passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      assert.equal(await stabilityPool.currentEpoch(), "0");

      // Defaulter 6 liquidated
      const txL6 = await troveManager.liquidate(defaulter_6, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_6));
      assert.isTrue(txL6.receipt.status);

      // Check scale is 0, epoch is 1
      assert.equal(await stabilityPool.currentScale(), "0");
      assert.equal(await stabilityPool.currentEpoch(), "1");
      assert.equal(await stabilityPool.P(), dec(1, 18)); // P resets to 1e18 after pool-emptying

      // price doubles
      await priceFeed.setPrice(dec(200, 18));

      /* All depositors withdraw fully from SP.  Withdraw in reverse order, so that the largest remaining
      deposit (F) withdraws first, and does not get extra DEFT gains from the periods between withdrawals */
      for (depositor of [F, E, D, C, B, A]) {
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: depositor });
      }

      const DEFTGain_A = await deftToken.balanceOf(A);
      const DEFTGain_B = await deftToken.balanceOf(B);
      const DEFTGain_C = await deftToken.balanceOf(C);
      const DEFTGain_D = await deftToken.balanceOf(D);
      const DEFTGain_E = await deftToken.balanceOf(E);
      const DEFTGain_F = await deftToken.balanceOf(F);

      /* Expect each deposit to have earned 100% of the DEFT issuance for the month in which it was active, prior
     to the liquidation that mostly depleted it.  Error tolerance = 1e-3 tokens. */

      const expectedGainA = issuance_M1.add(issuance_M2.div(toBN("100000")));
      const expectedGainB = issuance_M2
        .add(issuance_M3.div(toBN("100000")))
        .mul(toBN("99999"))
        .div(toBN("100000"));
      const expectedGainC = issuance_M3
        .add(issuance_M4.div(toBN("100000")))
        .mul(toBN("99999"))
        .div(toBN("100000"));
      const expectedGainD = issuance_M4
        .add(issuance_M5.div(toBN("100000")))
        .mul(toBN("99999"))
        .div(toBN("100000"));
      const expectedGainE = issuance_M5
        .add(issuance_M6.div(toBN("100000")))
        .mul(toBN("99999"))
        .div(toBN("100000"));
      const expectedGainF = issuance_M6.mul(toBN("99999")).div(toBN("100000"));

      assert.isAtMost(getDifference(expectedGainA, DEFTGain_A), 1e15);
      assert.isAtMost(getDifference(expectedGainB, DEFTGain_B), 1e15);
      assert.isAtMost(getDifference(expectedGainC, DEFTGain_C), 1e15);
      assert.isAtMost(getDifference(expectedGainD, DEFTGain_D), 1e15);

      assert.isAtMost(getDifference(expectedGainE, DEFTGain_E), 1e15);
      assert.isAtMost(getDifference(expectedGainF, DEFTGain_F), 1e15);
    });

    // --- FrontEnds and kickback rates

    // Simple case: 4 depositors, equal stake. No liquidations.
    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct DEFT gain. No liquidations. Front ends and kickback rates.", async () => {
      // Register 2 front ends
      const kickbackRate_F1 = toBN(dec(5, 17)); // F1 kicks 50% back to depositor
      const kickbackRate_F2 = toBN(dec(80, 16)); // F2 kicks 80% back to depositor

      await stabilityPool.registerFrontEnd(kickbackRate_F1, { from: frontEnd_1 });
      await stabilityPool.registerFrontEnd(kickbackRate_F2, { from: frontEnd_2 });

      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(100, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: E,
        lowerHint: E,
        extraParams: { from: E, value: toBN(dec(100, "ether")) }
      });

      // Check all DEFT balances are initially 0
      assert.equal(await deftToken.balanceOf(A), 0);
      assert.equal(await deftToken.balanceOf(B), 0);
      assert.equal(await deftToken.balanceOf(C), 0);
      assert.equal(await deftToken.balanceOf(D), 0);
      assert.equal(await deftToken.balanceOf(frontEnd_1), 0);
      assert.equal(await deftToken.balanceOf(frontEnd_2), 0);

      // A, B, C, D deposit
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_2, { from: C });
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: D });

      // Check initial frontEnd stakes are correct:
      F1_stake = await stabilityPool.frontEndStakes(frontEnd_1);
      F2_stake = await stabilityPool.frontEndStakes(frontEnd_2);

      assert.equal(F1_stake, dec(10000, 18));
      assert.equal(F2_stake, dec(20000, 18));

      // One year passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_YEAR),
        web3.currentProvider
      );

      // E deposits, triggering DEFT gains for A,B,C,D,F1,F2. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: E });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: E });

      // Expected issuance for year 1 is 50% of total supply.
      const expectedIssuance_Y1 = communityDEFTSupply.div(toBN("2"));

      // Get actual DEFT gains
      const A_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(C);
      const D_DEFTGain_Y1 = await stabilityPool.getDepositorDEFTGain(D);
      const F1_DEFTGain_Y1 = await stabilityPool.getFrontEndDEFTGain(frontEnd_1);
      const F2_DEFTGain_Y1 = await stabilityPool.getFrontEndDEFTGain(frontEnd_2);

      // Expected depositor and front-end gains
      const A_expectedGain_Y1 = kickbackRate_F1
        .mul(expectedIssuance_Y1)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const B_expectedGain_Y1 = kickbackRate_F2
        .mul(expectedIssuance_Y1)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const C_expectedGain_Y1 = kickbackRate_F2
        .mul(expectedIssuance_Y1)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const D_expectedGain_Y1 = expectedIssuance_Y1.div(toBN("4"));

      const F1_expectedGain_Y1 = toBN(dec(1, 18))
        .sub(kickbackRate_F1)
        .mul(expectedIssuance_Y1)
        .div(toBN("4")) // F1's share = 100/400 = 1/4
        .div(toBN(dec(1, 18)));

      const F2_expectedGain_Y1 = toBN(dec(1, 18))
        .sub(kickbackRate_F2)
        .mul(expectedIssuance_Y1)
        .div(toBN("2")) // F2's share = 200/400 = 1/2
        .div(toBN(dec(1, 18)));

      // Check gains are correct, error tolerance = 1e-6 of a token
      assert.isAtMost(getDifference(A_DEFTGain_Y1, A_expectedGain_Y1), 1e12);
      assert.isAtMost(getDifference(B_DEFTGain_Y1, B_expectedGain_Y1), 1e12);
      assert.isAtMost(getDifference(C_DEFTGain_Y1, C_expectedGain_Y1), 1e12);
      assert.isAtMost(getDifference(D_DEFTGain_Y1, D_expectedGain_Y1), 1e12);

      assert.isAtMost(getDifference(F1_DEFTGain_Y1, F1_expectedGain_Y1), 1e12);
      assert.isAtMost(getDifference(F2_DEFTGain_Y1, F2_expectedGain_Y1), 1e12);

      // Another year passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider);

      // E deposits, triggering DEFT gains for A,B,CD,F1, F2. Withdraws immediately after
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: E });
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: E });

      // Expected gains for each depositor in Y2(25% total issued).  .
      const expectedIssuance_Y2 = communityDEFTSupply.div(toBN("4"));

      const expectedFinalIssuance = expectedIssuance_Y1.add(expectedIssuance_Y2);

      // Expected final gains
      const A_expectedFinalGain = kickbackRate_F1
        .mul(expectedFinalIssuance)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const B_expectedFinalGain = kickbackRate_F2
        .mul(expectedFinalIssuance)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const C_expectedFinalGain = kickbackRate_F2
        .mul(expectedFinalIssuance)
        .div(toBN("4"))
        .div(toBN(dec(1, 18)));
      const D_expectedFinalGain = expectedFinalIssuance.div(toBN("4"));

      const F1_expectedFinalGain = th
        .toBN(dec(1, 18))
        .sub(kickbackRate_F1)
        .mul(expectedFinalIssuance)
        .div(toBN("4")) // F1's share = 100/400 = 1/4
        .div(toBN(dec(1, 18)));

      const F2_expectedFinalGain = th
        .toBN(dec(1, 18))
        .sub(kickbackRate_F2)
        .mul(expectedFinalIssuance)
        .div(toBN("2")) // F2's share = 200/400 = 1/2
        .div(toBN(dec(1, 18)));

      // Each depositor fully withdraws
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A });
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: B });
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: C });
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: D });

      // Check DEFT balances increase by correct amount
      assert.isAtMost(getDifference(await deftToken.balanceOf(A), A_expectedFinalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(B), B_expectedFinalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(C), C_expectedFinalGain), 1e12);
      assert.isAtMost(getDifference(await deftToken.balanceOf(D), D_expectedFinalGain), 1e12);
      assert.isAtMost(
        getDifference(await deftToken.balanceOf(frontEnd_1), F1_expectedFinalGain),
        1e12
      );
      assert.isAtMost(
        getDifference(await deftToken.balanceOf(frontEnd_2), F2_expectedFinalGain),
        1e12
      );
    });

    // A, B, C, D deposit 10k,20k,30k,40k.
    // F1: A
    // F2: B, C
    // D makes a naked deposit (no front end)
    // Pool size: 100k
    // 1 month passes. 1st liquidation: 500. All deposits reduced by 500/1000 = 50%.  A:5000,   B:10000, C:15000,   D:20000
    // Pool size: 50k
    // E deposits 30k via F1                                                          A:5000,   B:10000, C:15000,   D:20000, E:30000
    // Pool size: 80k
    // 1 month passes. 2nd liquidation: 20k. All deposits reduced by 200/800 = 25%    A:3750, B:7500,  C:11250, D:15000, E:22500
    // Pool size: 60k
    // B tops up 40k                                                                  A:3750, B:47500, C:11250, D:1500, E:22500
    // Pool size: 100k
    // 1 month passes. 3rd liquidation: 10k. All deposits reduced by 10%.             A:3375, B:42750, C:10125, D:13500, E:20250
    // Pool size 90k
    // C withdraws 10k                                                                A:3375, B:42750, C:125, D:13500, E:20250
    // Pool size 80k
    // 1 month passes.
    // All withdraw
    it("withdrawFromSP(): Depositors with varying initial deposit withdraw correct DEFT gain. Front ends and kickback rates", async () => {
      // Register 2 front ends
      const F1_kickbackRate = toBN(dec(5, 17)); // F1 kicks 50% back to depositor
      const F2_kickbackRate = toBN(dec(80, 16)); // F2 kicks 80% back to depositor

      await stabilityPool.registerFrontEnd(F1_kickbackRate, { from: frontEnd_1 });
      await stabilityPool.registerFrontEnd(F2_kickbackRate, { from: frontEnd_2 });

      const initialIssuance = await communityIssuanceTester.totalDEFTIssued();
      assert.equal(initialIssuance, 0);

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(60000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(800, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(30000, 18)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(400, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(40000, 18)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(500, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(30000, 18)),
        upperHint: E,
        lowerHint: E,
        extraParams: { from: E, value: toBN(dec(400, "ether")) }
      });

      // D1, D2, D3 open troves with total debt 50k, 30k, 10k respectively (inc. gas comp)
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(50000, 18)),
        upperHint: defaulter_1,
        lowerHint: defaulter_1,
        extraParams: { from: defaulter_1, value: toBN(dec(500, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(20000, 18)),
        upperHint: defaulter_2,
        lowerHint: defaulter_2,
        extraParams: { from: defaulter_2, value: toBN(dec(200, "ether")) }
      });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: await getOpenTroveUSDDAmount(dec(10000, 18)),
        upperHint: defaulter_3,
        lowerHint: defaulter_3,
        extraParams: { from: defaulter_3, value: toBN(dec(100, "ether")) }
      });

      // Check all DEFT balances are initially 0
      assert.equal(await deftToken.balanceOf(A), 0);
      assert.equal(await deftToken.balanceOf(B), 0);
      assert.equal(await deftToken.balanceOf(C), 0);
      assert.equal(await deftToken.balanceOf(D), 0);
      assert.equal(await deftToken.balanceOf(frontEnd_1), 0);
      assert.equal(await deftToken.balanceOf(frontEnd_2), 0);

      // A, B, C, D deposit
      await stabilityPool.provideToSP(dec(10000, 18), frontEnd_1, { from: A });
      await stabilityPool.provideToSP(dec(20000, 18), frontEnd_2, { from: B });
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_2, { from: C });
      await stabilityPool.provideToSP(dec(40000, 18), ZERO_ADDRESS, { from: D });

      // Price Drops, defaulters become undercollateralized
      await priceFeed.setPrice(dec(105, 18));
      assert.isFalse(await th.checkRecoveryMode(contracts));

      // Check initial frontEnd stakes are correct:
      F1_stake = await stabilityPool.frontEndStakes(frontEnd_1);
      F2_stake = await stabilityPool.frontEndStakes(frontEnd_2);

      assert.equal(F1_stake, dec(10000, 18));
      assert.equal(F2_stake, dec(50000, 18));

      // Month 1 passes
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_MONTH),
        web3.currentProvider
      );

      assert.equal(await stabilityPool.getTotalUSDDDeposits(), dec(100000, 18)); // total 100k

      // LIQUIDATION 1
      await troveManager.liquidate(defaulter_1);
      assert.isFalse(await sortedTroves.contains(defaulter_1));

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(50000, 18)); // 50k

      // --- CHECK GAINS AFTER L1 ---

      // During month 1, deposit sizes are: A:10000, B:20000, C:30000, D:40000.  Total: 100000
      // Expected gains for each depositor after month 1
      const A_share_M1 = issuance_M1.mul(toBN("10000")).div(toBN("100000"));
      const A_expectedDEFTGain_M1 = F1_kickbackRate.mul(A_share_M1).div(toBN(dec(1, 18)));

      const B_share_M1 = issuance_M1.mul(toBN("20000")).div(toBN("100000"));
      const B_expectedDEFTGain_M1 = F2_kickbackRate.mul(B_share_M1).div(toBN(dec(1, 18)));

      const C_share_M1 = issuance_M1.mul(toBN("30000")).div(toBN("100000"));
      const C_expectedDEFTGain_M1 = F2_kickbackRate.mul(C_share_M1).div(toBN(dec(1, 18)));

      const D_share_M1 = issuance_M1.mul(toBN("40000")).div(toBN("100000"));
      const D_expectedDEFTGain_M1 = D_share_M1;

      // F1's stake = A
      const F1_expectedDEFTGain_M1 = toBN(dec(1, 18))
        .sub(F1_kickbackRate)
        .mul(A_share_M1)
        .div(toBN(dec(1, 18)));

      // F2's stake = B + C
      const F2_expectedDEFTGain_M1 = toBN(dec(1, 18))
        .sub(F2_kickbackRate)
        .mul(B_share_M1.add(C_share_M1))
        .div(toBN(dec(1, 18)));

      // Check DEFT gain
      const A_DEFTGain_M1 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_M1 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_M1 = await stabilityPool.getDepositorDEFTGain(C);
      const D_DEFTGain_M1 = await stabilityPool.getDepositorDEFTGain(D);
      const F1_DEFTGain_M1 = await stabilityPool.getFrontEndDEFTGain(frontEnd_1);
      const F2_DEFTGain_M1 = await stabilityPool.getFrontEndDEFTGain(frontEnd_2);

      // Check gains are correct, error tolerance = 1e-3 of a token
      assert.isAtMost(getDifference(A_DEFTGain_M1, A_expectedDEFTGain_M1), 1e15);
      assert.isAtMost(getDifference(B_DEFTGain_M1, B_expectedDEFTGain_M1), 1e15);
      assert.isAtMost(getDifference(C_DEFTGain_M1, C_expectedDEFTGain_M1), 1e15);
      assert.isAtMost(getDifference(D_DEFTGain_M1, D_expectedDEFTGain_M1), 1e15);
      assert.isAtMost(getDifference(F1_DEFTGain_M1, F1_expectedDEFTGain_M1), 1e15);
      assert.isAtMost(getDifference(F2_DEFTGain_M1, F2_expectedDEFTGain_M1), 1e15);

      // E deposits 30k via F1
      await stabilityPool.provideToSP(dec(30000, 18), frontEnd_1, { from: E });

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(80000, 18));

      // Month 2 passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // LIQUIDATION 2
      await troveManager.liquidate(defaulter_2);
      assert.isFalse(await sortedTroves.contains(defaulter_2));

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(60000, 18));

      const startTime = await communityIssuanceTester.startTime();
      const currentTime = await th.getLatestBlockTimestamp(web3);
      const timePassed = toBN(currentTime).sub(startTime);

      // --- CHECK GAINS AFTER L2 ---

      // During month 2, deposit sizes:  A:5000,   B:10000, C:15000,  D:20000, E:30000. Total: 80000

      // Expected gains for each depositor after month 2
      const A_share_M2 = issuance_M2.mul(toBN("5000")).div(toBN("80000"));
      const A_expectedDEFTGain_M2 = F1_kickbackRate.mul(A_share_M2).div(toBN(dec(1, 18)));

      const B_share_M2 = issuance_M2.mul(toBN("10000")).div(toBN("80000"));
      const B_expectedDEFTGain_M2 = F2_kickbackRate.mul(B_share_M2).div(toBN(dec(1, 18)));

      const C_share_M2 = issuance_M2.mul(toBN("15000")).div(toBN("80000"));
      const C_expectedDEFTGain_M2 = F2_kickbackRate.mul(C_share_M2).div(toBN(dec(1, 18)));

      const D_share_M2 = issuance_M2.mul(toBN("20000")).div(toBN("80000"));
      const D_expectedDEFTGain_M2 = D_share_M2;

      const E_share_M2 = issuance_M2.mul(toBN("30000")).div(toBN("80000"));
      const E_expectedDEFTGain_M2 = F1_kickbackRate.mul(E_share_M2).div(toBN(dec(1, 18)));

      // F1's stake = A + E
      const F1_expectedDEFTGain_M2 = toBN(dec(1, 18))
        .sub(F1_kickbackRate)
        .mul(A_share_M2.add(E_share_M2))
        .div(toBN(dec(1, 18)));

      // F2's stake = B + C
      const F2_expectedDEFTGain_M2 = toBN(dec(1, 18))
        .sub(F2_kickbackRate)
        .mul(B_share_M2.add(C_share_M2))
        .div(toBN(dec(1, 18)));

      // Check DEFT gains after month 2
      const A_DEFTGain_After_M2 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_After_M2 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_After_M2 = await stabilityPool.getDepositorDEFTGain(C);
      const D_DEFTGain_After_M2 = await stabilityPool.getDepositorDEFTGain(D);
      const E_DEFTGain_After_M2 = await stabilityPool.getDepositorDEFTGain(E);
      const F1_DEFTGain_After_M2 = await stabilityPool.getFrontEndDEFTGain(frontEnd_1);
      const F2_DEFTGain_After_M2 = await stabilityPool.getFrontEndDEFTGain(frontEnd_2);

      assert.isAtMost(
        getDifference(A_DEFTGain_After_M2, A_expectedDEFTGain_M2.add(A_expectedDEFTGain_M1)),
        1e15
      );
      assert.isAtMost(
        getDifference(B_DEFTGain_After_M2, B_expectedDEFTGain_M2.add(B_expectedDEFTGain_M1)),
        1e15
      );
      assert.isAtMost(
        getDifference(C_DEFTGain_After_M2, C_expectedDEFTGain_M2.add(C_expectedDEFTGain_M1)),
        1e15
      );
      assert.isAtMost(
        getDifference(D_DEFTGain_After_M2, D_expectedDEFTGain_M2.add(D_expectedDEFTGain_M1)),
        1e15
      );
      assert.isAtMost(getDifference(E_DEFTGain_After_M2, E_expectedDEFTGain_M2), 1e15);

      // Check F1 balance is his M1 gain (it was paid out when E joined through F1)
      const F1_DEFTBalance_After_M2 = await deftToken.balanceOf(frontEnd_1);
      assert.isAtMost(getDifference(F1_DEFTBalance_After_M2, F1_expectedDEFTGain_M1), 1e15);

      // Check F1's DEFT gain in system after M2: Just their gain due to M2
      assert.isAtMost(getDifference(F1_DEFTGain_After_M2, F1_expectedDEFTGain_M2), 1e15);

      // Check F2 DEFT gain in system after M2: the sum of their gains from M1 + M2
      assert.isAtMost(
        getDifference(F2_DEFTGain_After_M2, F2_expectedDEFTGain_M2.add(F2_expectedDEFTGain_M1)),
        1e15
      );

      // B tops up 40k via F2
      await stabilityPool.provideToSP(dec(40000, 18), frontEnd_2, { from: B });

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(100000, 18));

      // Month 3 passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // LIQUIDATION 3
      await troveManager.liquidate(defaulter_3);
      assert.isFalse(await sortedTroves.contains(defaulter_3));

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(90000, 18));

      // --- CHECK GAINS AFTER L3 ---

      // During month 3, deposit sizes: A:3750, B:47500, C:11250, D:15000, E:22500, Total: 100000

      // Expected gains for each depositor after month 3
      const A_share_M3 = issuance_M3.mul(toBN("3750")).div(toBN("100000"));
      const A_expectedDEFTGain_M3 = F1_kickbackRate.mul(A_share_M3).div(toBN(dec(1, 18)));

      const B_share_M3 = issuance_M3.mul(toBN("47500")).div(toBN("100000"));
      const B_expectedDEFTGain_M3 = F2_kickbackRate.mul(B_share_M3).div(toBN(dec(1, 18)));

      const C_share_M3 = issuance_M3.mul(toBN("11250")).div(toBN("100000"));
      const C_expectedDEFTGain_M3 = F2_kickbackRate.mul(C_share_M3).div(toBN(dec(1, 18)));

      const D_share_M3 = issuance_M3.mul(toBN("15000")).div(toBN("100000"));
      const D_expectedDEFTGain_M3 = D_share_M3;

      const E_share_M3 = issuance_M3.mul(toBN("22500")).div(toBN("100000"));
      const E_expectedDEFTGain_M3 = F1_kickbackRate.mul(E_share_M3).div(toBN(dec(1, 18)));

      // F1's stake = A + E
      const F1_expectedDEFTGain_M3 = toBN(dec(1, 18))
        .sub(F1_kickbackRate)
        .mul(A_share_M3.add(E_share_M3))
        .div(toBN(dec(1, 18)));

      // F2's stake = B + C
      const F2_expectedDEFTGain_M3 = toBN(dec(1, 18))
        .sub(F2_kickbackRate)
        .mul(B_share_M3.add(C_share_M3))
        .div(toBN(dec(1, 18)));

      // Check DEFT gains after month 3
      const A_DEFTGain_After_M3 = await stabilityPool.getDepositorDEFTGain(A);
      const B_DEFTGain_After_M3 = await stabilityPool.getDepositorDEFTGain(B);
      const C_DEFTGain_After_M3 = await stabilityPool.getDepositorDEFTGain(C);
      const D_DEFTGain_After_M3 = await stabilityPool.getDepositorDEFTGain(D);
      const E_DEFTGain_After_M3 = await stabilityPool.getDepositorDEFTGain(E);
      const F1_DEFTGain_After_M3 = await stabilityPool.getFrontEndDEFTGain(frontEnd_1);
      const F2_DEFTGain_After_M3 = await stabilityPool.getFrontEndDEFTGain(frontEnd_2);

      // Expect A, C, D DEFT system gains to equal their gains from (M1 + M2 + M3)
      assert.isAtMost(
        getDifference(
          A_DEFTGain_After_M3,
          A_expectedDEFTGain_M3.add(A_expectedDEFTGain_M2).add(A_expectedDEFTGain_M1)
        ),
        1e15
      );
      assert.isAtMost(
        getDifference(
          C_DEFTGain_After_M3,
          C_expectedDEFTGain_M3.add(C_expectedDEFTGain_M2).add(C_expectedDEFTGain_M1)
        ),
        1e15
      );
      assert.isAtMost(
        getDifference(
          D_DEFTGain_After_M3,
          D_expectedDEFTGain_M3.add(D_expectedDEFTGain_M2).add(D_expectedDEFTGain_M1)
        ),
        1e15
      );

      // Expect E's DEFT system gain to equal their gains from (M2 + M3)
      assert.isAtMost(
        getDifference(E_DEFTGain_After_M3, E_expectedDEFTGain_M3.add(E_expectedDEFTGain_M2)),
        1e15
      );

      // Expect B DEFT system gains to equal gains just from M3 (his topup paid out his gains from M1 + M2)
      assert.isAtMost(getDifference(B_DEFTGain_After_M3, B_expectedDEFTGain_M3), 1e15);

      // Expect B DEFT balance to equal gains from (M1 + M2)
      const B_DEFTBalance_After_M3 = await await deftToken.balanceOf(B);
      assert.isAtMost(
        getDifference(B_DEFTBalance_After_M3, B_expectedDEFTGain_M2.add(B_expectedDEFTGain_M1)),
        1e15
      );

      // Expect F1 DEFT system gains to equal their gain from (M2 + M3)
      assert.isAtMost(
        getDifference(F1_DEFTGain_After_M3, F1_expectedDEFTGain_M3.add(F1_expectedDEFTGain_M2)),
        1e15
      );

      // Expect F1 DEFT balance to equal their M1 gain
      const F1_DEFTBalance_After_M3 = await deftToken.balanceOf(frontEnd_1);
      assert.isAtMost(getDifference(F1_DEFTBalance_After_M3, F1_expectedDEFTGain_M1), 1e15);

      // Expect F2 DEFT system gains to equal their gain from M3
      assert.isAtMost(getDifference(F2_DEFTGain_After_M3, F2_expectedDEFTGain_M3), 1e15);

      // Expect F2 DEFT balance to equal their gain from M1 + M2
      const F2_DEFTBalance_After_M3 = await deftToken.balanceOf(frontEnd_2);
      assert.isAtMost(
        getDifference(F2_DEFTBalance_After_M3, F2_expectedDEFTGain_M2.add(F2_expectedDEFTGain_M1)),
        1e15
      );

      // Expect deposit C now to be 10125 USDD
      const C_compoundedUSDDDeposit = await stabilityPool.getCompoundedUSDDDeposit(C);
      assert.isAtMost(getDifference(C_compoundedUSDDDeposit, dec(10125, 18)), 1000);

      // --- C withdraws ---

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(90000, 18));

      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: C });

      th.assertIsApproximatelyEqual(await stabilityPool.getTotalUSDDDeposits(), dec(80000, 18));

      // Month 4 passes
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // All depositors fully withdraw
      for (depositor of [A, B, C, D, E]) {
        await stabilityPool.withdrawFromSP(dec(100000, 18), { from: depositor });
        const compoundedUSDDDeposit = await stabilityPool.getCompoundedUSDDDeposit(depositor);
        assert.equal(compoundedUSDDDeposit, "0");
      }

      // During month 4, deposit sizes: A:3375, B:42750, C:125, D:13500, E:20250, Total: 80000

      // Expected gains for each depositor after month 4
      const A_share_M4 = issuance_M4.mul(toBN("3375")).div(toBN("80000")); // 3375/800
      const A_expectedDEFTGain_M4 = F1_kickbackRate.mul(A_share_M4).div(toBN(dec(1, 18)));

      const B_share_M4 = issuance_M4.mul(toBN("42750")).div(toBN("80000")); // 42750/80000
      const B_expectedDEFTGain_M4 = F2_kickbackRate.mul(B_share_M4).div(toBN(dec(1, 18)));

      const C_share_M4 = issuance_M4.mul(toBN("125")).div(toBN("80000")); // 125/80000
      const C_expectedDEFTGain_M4 = F2_kickbackRate.mul(C_share_M4).div(toBN(dec(1, 18)));

      const D_share_M4 = issuance_M4.mul(toBN("13500")).div(toBN("80000"));
      const D_expectedDEFTGain_M4 = D_share_M4;

      const E_share_M4 = issuance_M4.mul(toBN("20250")).div(toBN("80000")); // 2025/80000
      const E_expectedDEFTGain_M4 = F1_kickbackRate.mul(E_share_M4).div(toBN(dec(1, 18)));

      // F1's stake = A + E
      const F1_expectedDEFTGain_M4 = toBN(dec(1, 18))
        .sub(F1_kickbackRate)
        .mul(A_share_M4.add(E_share_M4))
        .div(toBN(dec(1, 18)));

      // F2's stake = B + C
      const F2_expectedDEFTGain_M4 = toBN(dec(1, 18))
        .sub(F2_kickbackRate)
        .mul(B_share_M4.add(C_share_M4))
        .div(toBN(dec(1, 18)));

      // Get final DEFT balances
      const A_FinalDEFTBalance = await deftToken.balanceOf(A);
      const B_FinalDEFTBalance = await deftToken.balanceOf(B);
      const C_FinalDEFTBalance = await deftToken.balanceOf(C);
      const D_FinalDEFTBalance = await deftToken.balanceOf(D);
      const E_FinalDEFTBalance = await deftToken.balanceOf(E);
      const F1_FinalDEFTBalance = await deftToken.balanceOf(frontEnd_1);
      const F2_FinalDEFTBalance = await deftToken.balanceOf(frontEnd_2);

      const A_expectedFinalDEFTBalance = A_expectedDEFTGain_M1.add(A_expectedDEFTGain_M2)
        .add(A_expectedDEFTGain_M3)
        .add(A_expectedDEFTGain_M4);

      const B_expectedFinalDEFTBalance = B_expectedDEFTGain_M1.add(B_expectedDEFTGain_M2)
        .add(B_expectedDEFTGain_M3)
        .add(B_expectedDEFTGain_M4);

      const C_expectedFinalDEFTBalance = C_expectedDEFTGain_M1.add(C_expectedDEFTGain_M2)
        .add(C_expectedDEFTGain_M3)
        .add(C_expectedDEFTGain_M4);

      const D_expectedFinalDEFTBalance = D_expectedDEFTGain_M1.add(D_expectedDEFTGain_M2)
        .add(D_expectedDEFTGain_M3)
        .add(D_expectedDEFTGain_M4);

      const E_expectedFinalDEFTBalance = E_expectedDEFTGain_M2.add(E_expectedDEFTGain_M3).add(
        E_expectedDEFTGain_M4
      );

      const F1_expectedFinalDEFTBalance = F1_expectedDEFTGain_M1.add(F1_expectedDEFTGain_M2)
        .add(F1_expectedDEFTGain_M3)
        .add(F1_expectedDEFTGain_M4);

      const F2_expectedFinalDEFTBalance = F2_expectedDEFTGain_M1.add(F2_expectedDEFTGain_M2)
        .add(F2_expectedDEFTGain_M3)
        .add(F2_expectedDEFTGain_M4);

      assert.isAtMost(getDifference(A_FinalDEFTBalance, A_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(B_FinalDEFTBalance, B_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(C_FinalDEFTBalance, C_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(D_FinalDEFTBalance, D_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(E_FinalDEFTBalance, E_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(F1_FinalDEFTBalance, F1_expectedFinalDEFTBalance), 1e15);
      assert.isAtMost(getDifference(F2_FinalDEFTBalance, F2_expectedFinalDEFTBalance), 1e15);
    });

    /* Serial scale changes, with one front end

    F1 kickbackRate: 80%

    A, B make deposit 5000 USDD via F1
    1 month passes. L1 depletes P: P = 1e-5*P L1:  9999.9 USDD, 1 ETH.  scale = 0
    C makes deposit 10000  via F1
    1 month passes. L2 depletes P: P = 1e-5*P L2:  9999.9 USDD, 1 ETH  scale = 1
    D makes deposit 10000 via F1
    1 month passes. L3 depletes P: P = 1e-5*P L3:  9999.9 USDD, 1 ETH scale = 1
    E makes deposit 10000 via F1
    1 month passes. L3 depletes P: P = 1e-5*P L4:  9999.9 USDD, 1 ETH scale = 2
    A, B, C, D, E withdraw

    =========
    Expect front end withdraws ~3 month's worth of DEFT */

    it("withdrawFromSP(): Several deposits of 10k USDD span one scale factor change. Depositors withdraw correct DEFT gains", async () => {
      const kickbackRate = toBN(dec(80, 16)); // F1 kicks 80% back to depositor
      await stabilityPool.registerFrontEnd(kickbackRate, { from: frontEnd_1 });

      // Whale opens Trove with 10k ETH
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(10000, 18)),
        upperHint: whale,
        lowerHint: whale,
        extraParams: { from: whale, value: toBN(dec(10000, "ether")) }
      });

      const _4_Defaulters = [defaulter_1, defaulter_2, defaulter_3, defaulter_4];

      for (const defaulter of _4_Defaulters) {
        // Defaulters 1-4 each withdraw to 9999.9 debt (including gas comp)
        await openTrove({
          maxFeePercentage: th._100pct,
          usddAmount: await getOpenTroveUSDDAmount(dec(99999, 17)),
          upperHint: defaulter,
          lowerHint: defaulter,
          extraParams: { from: defaulter, value: toBN(dec(100, "ether")) }
        });
      }

      // Confirm all would-be depositors have 0 DEFT
      for (const depositor of [A, B, C, D, E]) {
        assert.equal(await deftToken.balanceOf(depositor), "0");
      }
      assert.equal(await deftToken.balanceOf(frontEnd_1), "0");

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Check scale is 0
      assert.equal(await stabilityPool.currentScale(), "0");

      // A, B provides 5000 USDD to SP
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(5000, 18)),
        upperHint: A,
        lowerHint: A,
        extraParams: { from: A, value: toBN(dec(200, "ether")) }
      });
      await stabilityPool.provideToSP(dec(5000, 18), frontEnd_1, { from: A });

      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(5000, 18)),
        upperHint: B,
        lowerHint: B,
        extraParams: { from: B, value: toBN(dec(200, "ether")) }
      });
      await stabilityPool.provideToSP(dec(5000, 18), frontEnd_1, { from: B });

      // 1 month passes (M1)
      await th.fastForwardTime(
        await getDuration(timeValues.SECONDS_IN_ONE_MONTH),
        web3.currentProvider
      );

      // Defaulter 1 liquidated.  Value of P updated to  to 9999999, i.e. in decimal, ~1e-10
      const txL1 = await troveManager.liquidate(defaulter_1, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_1));
      assert.isTrue(txL1.receipt.status);

      // Check scale is 0
      assert.equal(await stabilityPool.currentScale(), "0");

      // C provides to SP
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(99999, 17)),
        upperHint: C,
        lowerHint: C,
        extraParams: { from: C, value: toBN(dec(200, "ether")) }
      });
      await stabilityPool.provideToSP(dec(99999, 17), frontEnd_1, { from: C });

      // 1 month passes (M2)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 2 liquidated
      const txL2 = await troveManager.liquidate(defaulter_2, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_2));
      assert.isTrue(txL2.receipt.status);

      // Check scale is 1
      assert.equal(await stabilityPool.currentScale(), "1");

      // D provides to SP
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(99999, 17)),
        upperHint: D,
        lowerHint: D,
        extraParams: { from: D, value: toBN(dec(200, "ether")) }
      });
      await stabilityPool.provideToSP(dec(99999, 17), frontEnd_1, { from: D });

      // 1 month passes (M3)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 3 liquidated
      const txL3 = await troveManager.liquidate(defaulter_3, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_3));
      assert.isTrue(txL3.receipt.status);

      // Check scale is 1
      assert.equal(await stabilityPool.currentScale(), "1");

      // E provides to SP
      await openTrove({
        maxFeePercentage: th._100pct,
        usddAmount: toBN(dec(99999, 17)),
        upperHint: E,
        lowerHint: E,
        extraParams: { from: E, value: toBN(dec(200, "ether")) }
      });
      await stabilityPool.provideToSP(dec(99999, 17), frontEnd_1, { from: E });

      // 1 month passes (M4)
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider);

      // Defaulter 4 liquidated
      const txL4 = await troveManager.liquidate(defaulter_4, { from: owner });
      assert.isFalse(await sortedTroves.contains(defaulter_4));
      assert.isTrue(txL4.receipt.status);

      // Check scale is 2
      assert.equal(await stabilityPool.currentScale(), "2");

      /* All depositors withdraw fully from SP.  Withdraw in reverse order, so that the largest remaining
      deposit (F) withdraws first, and does not get extra DEFT gains from the periods between withdrawals */
      for (depositor of [E, D, C, B, A]) {
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: depositor });
      }

      const DEFTGain_A = await deftToken.balanceOf(A);
      const DEFTGain_B = await deftToken.balanceOf(B);
      const DEFTGain_C = await deftToken.balanceOf(C);
      const DEFTGain_D = await deftToken.balanceOf(D);
      const DEFTGain_E = await deftToken.balanceOf(E);

      const DEFTGain_F1 = await deftToken.balanceOf(frontEnd_1);

      /* Expect each deposit to have earned DEFT issuance for the month in which it was active, prior
     to the liquidation that mostly depleted it:
     
     expectedDEFTGain_A:  (k * M1 / 2) + (k * M2 / 2) / 100000   
     expectedDEFTGain_B:  (k * M1 / 2) + (k * M2 / 2) / 100000                           

     expectedDEFTGain_C:  ((k * M2)  + (k * M3) / 100000) * 9999.9/10000   
     expectedDEFTGain_D:  ((k * M3)  + (k * M4) / 100000) * 9999.9/10000 
     expectedDEFTGain_E:  (k * M4) * 9999.9/10000 

     expectedDEFTGain_F1:  (1 - k) * (M1 + M2 + M3 + M4)
     */

      const expectedDEFTGain_A_and_B = kickbackRate
        .mul(issuance_M1)
        .div(toBN("2"))
        .div(toBN(dec(1, 18))) // gain from L1
        .add(
          kickbackRate
            .mul(issuance_M2)
            .div(toBN("2"))
            .div(toBN(dec(1, 18)))
            .div(toBN("100000"))
        ); // gain from L2 after deposit depleted

      const expectedDEFTGain_C = kickbackRate
        .mul(issuance_M2)
        .div(toBN(dec(1, 18))) // gain from L2
        .add(
          kickbackRate
            .mul(issuance_M3)
            .div(toBN(dec(1, 18)))
            .div(toBN("100000")) // gain from L3 after deposit depleted
        )
        .mul(toBN("99999"))
        .div(toBN("100000")); // Scale by 9999.9/10000

      const expectedDEFTGain_D = kickbackRate
        .mul(issuance_M3)
        .div(toBN(dec(1, 18))) // gain from L3
        .add(
          kickbackRate
            .mul(issuance_M4)
            .div(toBN(dec(1, 18)))
            .div(toBN("100000")) // gain from L4
        )
        .mul(toBN("99999"))
        .div(toBN("100000")); // Scale by 9999.9/10000

      const expectedDEFTGain_E = kickbackRate
        .mul(issuance_M4)
        .div(toBN(dec(1, 18))) // gain from L4
        .mul(toBN("99999"))
        .div(toBN("100000")); // Scale by 9999.9/10000

      const issuance1st4Months = issuance_M1.add(issuance_M2).add(issuance_M3).add(issuance_M4);
      const expectedDEFTGain_F1 = toBN(dec(1, 18))
        .sub(kickbackRate)
        .mul(issuance1st4Months)
        .div(toBN(dec(1, 18)));

      assert.isAtMost(getDifference(expectedDEFTGain_A_and_B, DEFTGain_A), 1e15);
      assert.isAtMost(getDifference(expectedDEFTGain_A_and_B, DEFTGain_B), 1e15);
      assert.isAtMost(getDifference(expectedDEFTGain_C, DEFTGain_C), 1e15);
      assert.isAtMost(getDifference(expectedDEFTGain_D, DEFTGain_D), 1e15);
      assert.isAtMost(getDifference(expectedDEFTGain_E, DEFTGain_E), 1e15);
      assert.isAtMost(getDifference(expectedDEFTGain_F1, DEFTGain_F1), 1e15);
    });
  });
});

contract("Reset chain state", async accounts => {});
