const deploymentHelper = require("../utils/deploymentHelpers.js");
const testHelpers = require("../utils/testHelpers.js");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;

const ZERO_ADDRESS = th.ZERO_ADDRESS;

const ZERO = toBN("0");

/*
 * Naive fuzz test that checks whether all SP depositors can successfully withdraw from the SP, after a random sequence
 * of deposits and liquidations.
 *
 * The test cases tackle different size ranges for liquidated collateral and SP deposits.
 */

contract(
  "PoolManager - random liquidations/deposits, then check all depositors can withdraw",
  async accounts => {
    const whale = accounts[accounts.length - 1];

    let priceFeed;
    let usddToken;
    let troveManager;
    let stabilityPool;
    let sortedTroves;
    let borrowerOperations;

    const skyrocketPriceAndCheckAllTrovesSafe = async () => {
      // price skyrockets, therefore no undercollateralized troes
      await priceFeed.setPrice(dec(1000, 18));
      const lowestICR = await troveManager.getCurrentICR(
        await sortedTroves.getLast(),
        dec(1000, 18)
      );
      assert.isTrue(lowestICR.gt(toBN(dec(110, 16))));
    };

    const performLiquidation = async (remainingDefaulters, liquidatedAccountsDict) => {
      if (remainingDefaulters.length === 0) {
        return;
      }

      const randomDefaulterIndex = Math.floor(Math.random() * remainingDefaulters.length);
      const randomDefaulter = remainingDefaulters[randomDefaulterIndex];

      const liquidatedUSDD = (await troveManager.Troves(randomDefaulter))[0];
      const liquidatedETH = (await troveManager.Troves(randomDefaulter))[1];

      const price = await priceFeed.getPrice();
      const ICR = (await troveManager.getCurrentICR(randomDefaulter, price)).toString();
      const ICRPercent = ICR.slice(0, ICR.length - 16);

      console.log(`SP address: ${stabilityPool.address}`);
      const USDDinPoolBefore = await stabilityPool.getTotalUSDDDeposits();
      const liquidatedTx = await troveManager.liquidate(randomDefaulter, { from: accounts[0] });
      const USDDinPoolAfter = await stabilityPool.getTotalUSDDDeposits();

      assert.isTrue(liquidatedTx.receipt.status);

      if (liquidatedTx.receipt.status) {
        liquidatedAccountsDict[randomDefaulter] = true;
        remainingDefaulters.splice(randomDefaulterIndex, 1);
      }
      if (await troveManager.checkRecoveryMode(price)) {
        console.log("recovery mode: TRUE");
      }

      console.log(
        `Liquidation. addr: ${th.squeezeAddr(
          randomDefaulter
        )} ICR: ${ICRPercent}% coll: ${liquidatedETH} debt: ${liquidatedUSDD} SP USDD before: ${USDDinPoolBefore} SP USDD after: ${USDDinPoolAfter} tx success: ${
          liquidatedTx.receipt.status
        }`
      );
    };

    const performSPDeposit = async (depositorAccounts, currentDepositors, currentDepositorsDict) => {
      const randomIndex = Math.floor(Math.random() * depositorAccounts.length);
      const randomDepositor = depositorAccounts[randomIndex];

      const userBalance = await usddToken.balanceOf(randomDepositor);
      const maxUSDDDeposit = userBalance.div(toBN(dec(1, 18)));

      const randomUSDDAmount = th.randAmountInWei(1, maxUSDDDeposit);

      const depositTx = await stabilityPool.provideToSP(randomUSDDAmount, ZERO_ADDRESS, {
        from: randomDepositor
      });

      assert.isTrue(depositTx.receipt.status);

      if (depositTx.receipt.status && !currentDepositorsDict[randomDepositor]) {
        currentDepositorsDict[randomDepositor] = true;
        currentDepositors.push(randomDepositor);
      }

      console.log(
        `SP deposit. addr: ${th.squeezeAddr(
          randomDepositor
        )} amount: ${randomUSDDAmount} tx success: ${depositTx.receipt.status} `
      );
    };

    const randomOperation = async (
      depositorAccounts,
      remainingDefaulters,
      currentDepositors,
      liquidatedAccountsDict,
      currentDepositorsDict
    ) => {
      const randomSelection = Math.floor(Math.random() * 2);

      if (randomSelection === 0) {
        await performLiquidation(remainingDefaulters, liquidatedAccountsDict);
      } else if (randomSelection === 1) {
        await performSPDeposit(depositorAccounts, currentDepositors, currentDepositorsDict);
      }
    };

    const systemContainsTroveUnder110 = async price => {
      const lowestICR = await troveManager.getCurrentICR(await sortedTroves.getLast(), price);
      console.log(
        `lowestICR: ${lowestICR}, lowestICR.lt(dec(110, 16)): ${lowestICR.lt(toBN(dec(110, 16)))}`
      );
      return lowestICR.lt(dec(110, 16));
    };

    const systemContainsTroveUnder100 = async price => {
      const lowestICR = await troveManager.getCurrentICR(await sortedTroves.getLast(), price);
      console.log(
        `lowestICR: ${lowestICR}, lowestICR.lt(dec(100, 16)): ${lowestICR.lt(toBN(dec(100, 16)))}`
      );
      return lowestICR.lt(dec(100, 16));
    };

    const getTotalDebtFromUndercollateralizedTroves = async (n, price) => {
      let totalDebt = ZERO;
      let trove = await sortedTroves.getLast();

      for (let i = 0; i < n; i++) {
        const ICR = await troveManager.getCurrentICR(trove, price);
        const debt = ICR.lt(toBN(dec(110, 16)))
          ? (await troveManager.getEntireDebtAndColl(trove))[0]
          : ZERO;

        totalDebt = totalDebt.add(debt);
        trove = await sortedTroves.getPrev(trove);
      }

      return totalDebt;
    };

    const clearAllUndercollateralizedTroves = async price => {
      /* Somewhat arbitrary way to clear under-collateralized troves:
       *
       * - If system is in Recovery Mode and contains troves with ICR < 100, whale draws the lowest trove's debt amount
       * and sends to lowest trove owner, who then closes their trove.
       *
       * - If system contains troves with ICR < 110, whale simply draws and makes an SP deposit
       * equal to the debt of the last 50 troves, before a liquidateTroves tx hits the last 50 troves.
       *
       * The intent is to avoid the system entering an endless loop where the SP is empty and debt is being forever liquidated/recycled
       * between active troves, and the existence of some under-collateralized troves blocks all SP depositors from withdrawing.
       *
       * Since the purpose of the fuzz test is to see if SP depositors can indeed withdraw *when they should be able to*,
       * we first need to put the system in a state with no under-collateralized troves (which are supposed to block SP withdrawals).
       */
      while (
        (await systemContainsTroveUnder100(price)) &&
        (await troveManager.checkRecoveryMode())
      ) {
        const lowestTrove = await sortedTroves.getLast();
        const lastTroveDebt = (await troveManager.getEntireDebtAndColl(trove))[0];
        await borrowerOperations.adjustTrove(0, 0, lastTroveDebt, true, whale, { from: whale });
        await usddToken.transfer(lowestTrove, lowestTroveDebt, { from: whale });
        await borrowerOperations.closeTrove({ from: lowestTrove });
      }

      while (await systemContainsTroveUnder110(price)) {
        const debtLowest50Troves = await getTotalDebtFromUndercollateralizedTroves(50, price);

        if (debtLowest50Troves.gt(ZERO)) {
          await borrowerOperations.adjustTrove(0, 0, debtLowest50Troves, true, whale, {
            from: whale
          });
          await stabilityPool.provideToSP(debtLowest50Troves, { from: whale });
        }

        await troveManager.liquidateTroves(50);
      }
    };

    const attemptWithdrawAllDeposits = async currentDepositors => {
      // First, liquidate all remaining undercollateralized troves, so that SP depositors may withdraw

      console.log("\n");
      console.log("--- Attempt to withdraw all deposits ---");
      console.log(`Depositors count: ${currentDepositors.length}`);

      for (depositor of currentDepositors) {
        const initialDeposit = (await stabilityPool.deposits(depositor))[0];
        const finalDeposit = await stabilityPool.getCompoundedUSDDDeposit(depositor);
        const ETHGain = await stabilityPool.getDepositorETHGain(depositor);
        const ETHinSP = (await stabilityPool.getETH()).toString();
        const USDDinSP = (await stabilityPool.getTotalUSDDDeposits()).toString();

        // Attempt to withdraw
        const withdrawalTx = await stabilityPool.withdrawFromSP(dec(1, 36), { from: depositor });

        const ETHinSPAfter = (await stabilityPool.getETH()).toString();
        const USDDinSPAfter = (await stabilityPool.getTotalUSDDDeposits()).toString();
        const USDDBalanceSPAfter = await usddToken.balanceOf(stabilityPool.address);
        const depositAfter = await stabilityPool.getCompoundedUSDDDeposit(depositor);

        console.log(`--Before withdrawal--
                    withdrawer addr: ${th.squeezeAddr(depositor)}
                     initial deposit: ${initialDeposit}
                     ETH gain: ${ETHGain}
                     ETH in SP: ${ETHinSP}
                     compounded deposit: ${finalDeposit} 
                     USDD in SP: ${USDDinSP}
                    
                    --After withdrawal--
                     Withdrawal tx success: ${withdrawalTx.receipt.status} 
                     Deposit after: ${depositAfter}
                     ETH remaining in SP: ${ETHinSPAfter}
                     SP USDD deposits tracker after: ${USDDinSPAfter}
                     SP USDD balance after: ${USDDBalanceSPAfter}
                     `);
        // Check each deposit can be withdrawn
        assert.isTrue(withdrawalTx.receipt.status);
        assert.equal(depositAfter, "0");
      }
    };

    describe("Stability Pool Withdrawals", async () => {
      before(async () => {
        console.log(`Number of accounts: ${accounts.length}`);
      });

      beforeEach(async () => {
        contracts = await deploymentHelper.deployLiquityCore();
        const DEFTContracts = await deploymentHelper.deployDEFTContracts();

        stabilityPool = contracts.stabilityPool;
        priceFeed = contracts.priceFeedTestnet;
        usddToken = contracts.usddToken;
        stabilityPool = contracts.stabilityPool;
        troveManager = contracts.troveManager;
        borrowerOperations = contracts.borrowerOperations;
        sortedTroves = contracts.sortedTroves;

        await deploymentHelper.connectDEFTContracts(DEFTContracts);
        await deploymentHelper.connectCoreContracts(contracts, DEFTContracts);
        await deploymentHelper.connectDEFTContractsToCore(DEFTContracts, contracts);
      });

      // mixed deposits/liquidations

      // ranges: low-low, low-high, high-low, high-high, full-full

      // full offsets, partial offsets
      // ensure full offset with whale2 in S
      // ensure partial offset with whale 3 in L

      it("Defaulters' Collateral in range [1, 1e8]. SP Deposits in range [100, 1e10]. ETH:USD = 100", async () => {
        // whale adds coll that holds TCR > 150%
        await borrowerOperations.openTrove(0, 0, whale, whale, { from: whale, value: dec(5, 29) });

        const numberOfOps = 5;
        const defaulterAccounts = accounts.slice(1, numberOfOps);
        const depositorAccounts = accounts.slice(numberOfOps + 1, numberOfOps * 2);

        const defaulterCollMin = 1;
        const defaulterCollMax = 100000000;
        const defaulterUSDDProportionMin = 91;
        const defaulterUSDDProportionMax = 180;

        const depositorCollMin = 1;
        const depositorCollMax = 100000000;
        const depositorUSDDProportionMin = 100;
        const depositorUSDDProportionMax = 100;

        const remainingDefaulters = [...defaulterAccounts];
        const currentDepositors = [];
        const liquidatedAccountsDict = {};
        const currentDepositorsDict = {};

        // setup:
        // account set L all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          defaulterCollMin,
          defaulterCollMax,
          defaulterAccounts,
          contracts,
          defaulterUSDDProportionMin,
          defaulterUSDDProportionMax,
          true
        );

        // account set S all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          depositorCollMin,
          depositorCollMax,
          depositorAccounts,
          contracts,
          depositorUSDDProportionMin,
          depositorUSDDProportionMax,
          true
        );

        // price drops, all L liquidateable
        await priceFeed.setPrice(dec(1, 18));

        // Random sequence of operations: liquidations and SP deposits
        for (i = 0; i < numberOfOps; i++) {
          await randomOperation(
            depositorAccounts,
            remainingDefaulters,
            currentDepositors,
            liquidatedAccountsDict,
            currentDepositorsDict
          );
        }

        await skyrocketPriceAndCheckAllTrovesSafe();

        const totalUSDDDepositsBeforeWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsBeforeWithdrawals = await stabilityPool.getETH();

        await attemptWithdrawAllDeposits(currentDepositors);

        const totalUSDDDepositsAfterWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsAfterWithdrawals = await stabilityPool.getETH();

        console.log(
          `Total USDD deposits before any withdrawals: ${totalUSDDDepositsBeforeWithdrawals}`
        );
        console.log(`Total ETH rewards before any withdrawals: ${totalETHRewardsBeforeWithdrawals}`);

        console.log(
          `Remaining USDD deposits after withdrawals: ${totalUSDDDepositsAfterWithdrawals}`
        );
        console.log(`Remaining ETH rewards after withdrawals: ${totalETHRewardsAfterWithdrawals}`);

        console.log(`current depositors length: ${currentDepositors.length}`);
        console.log(`remaining defaulters length: ${remainingDefaulters.length}`);
      });

      it("Defaulters' Collateral in range [1, 10]. SP Deposits in range [1e8, 1e10]. ETH:USD = 100", async () => {
        // whale adds coll that holds TCR > 150%
        await borrowerOperations.openTrove(0, 0, whale, whale, { from: whale, value: dec(5, 29) });

        const numberOfOps = 5;
        const defaulterAccounts = accounts.slice(1, numberOfOps);
        const depositorAccounts = accounts.slice(numberOfOps + 1, numberOfOps * 2);

        const defaulterCollMin = 1;
        const defaulterCollMax = 10;
        const defaulterUSDDProportionMin = 91;
        const defaulterUSDDProportionMax = 180;

        const depositorCollMin = 1000000;
        const depositorCollMax = 100000000;
        const depositorUSDDProportionMin = 100;
        const depositorUSDDProportionMax = 100;

        const remainingDefaulters = [...defaulterAccounts];
        const currentDepositors = [];
        const liquidatedAccountsDict = {};
        const currentDepositorsDict = {};

        // setup:
        // account set L all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          defaulterCollMin,
          defaulterCollMax,
          defaulterAccounts,
          contracts,
          defaulterUSDDProportionMin,
          defaulterUSDDProportionMax
        );

        // account set S all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          depositorCollMin,
          depositorCollMax,
          depositorAccounts,
          contracts,
          depositorUSDDProportionMin,
          depositorUSDDProportionMax
        );

        // price drops, all L liquidateable
        await priceFeed.setPrice(dec(100, 18));

        // Random sequence of operations: liquidations and SP deposits
        for (i = 0; i < numberOfOps; i++) {
          await randomOperation(
            depositorAccounts,
            remainingDefaulters,
            currentDepositors,
            liquidatedAccountsDict,
            currentDepositorsDict
          );
        }

        await skyrocketPriceAndCheckAllTrovesSafe();

        const totalUSDDDepositsBeforeWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsBeforeWithdrawals = await stabilityPool.getETH();

        await attemptWithdrawAllDeposits(currentDepositors);

        const totalUSDDDepositsAfterWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsAfterWithdrawals = await stabilityPool.getETH();

        console.log(
          `Total USDD deposits before any withdrawals: ${totalUSDDDepositsBeforeWithdrawals}`
        );
        console.log(`Total ETH rewards before any withdrawals: ${totalETHRewardsBeforeWithdrawals}`);

        console.log(
          `Remaining USDD deposits after withdrawals: ${totalUSDDDepositsAfterWithdrawals}`
        );
        console.log(`Remaining ETH rewards after withdrawals: ${totalETHRewardsAfterWithdrawals}`);

        console.log(`current depositors length: ${currentDepositors.length}`);
        console.log(`remaining defaulters length: ${remainingDefaulters.length}`);
      });

      it("Defaulters' Collateral in range [1e6, 1e8]. SP Deposits in range [100, 1000]. Every liquidation empties the Pool. ETH:USD = 100", async () => {
        // whale adds coll that holds TCR > 150%
        await borrowerOperations.openTrove(0, 0, whale, whale, { from: whale, value: dec(5, 29) });

        const numberOfOps = 5;
        const defaulterAccounts = accounts.slice(1, numberOfOps);
        const depositorAccounts = accounts.slice(numberOfOps + 1, numberOfOps * 2);

        const defaulterCollMin = 1000000;
        const defaulterCollMax = 100000000;
        const defaulterUSDDProportionMin = 91;
        const defaulterUSDDProportionMax = 180;

        const depositorCollMin = 1;
        const depositorCollMax = 10;
        const depositorUSDDProportionMin = 100;
        const depositorUSDDProportionMax = 100;

        const remainingDefaulters = [...defaulterAccounts];
        const currentDepositors = [];
        const liquidatedAccountsDict = {};
        const currentDepositorsDict = {};

        // setup:
        // account set L all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          defaulterCollMin,
          defaulterCollMax,
          defaulterAccounts,
          contracts,
          defaulterUSDDProportionMin,
          defaulterUSDDProportionMax
        );

        // account set S all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          depositorCollMin,
          depositorCollMax,
          depositorAccounts,
          contracts,
          depositorUSDDProportionMin,
          depositorUSDDProportionMax
        );

        // price drops, all L liquidateable
        await priceFeed.setPrice(dec(100, 18));

        // Random sequence of operations: liquidations and SP deposits
        for (i = 0; i < numberOfOps; i++) {
          await randomOperation(
            depositorAccounts,
            remainingDefaulters,
            currentDepositors,
            liquidatedAccountsDict,
            currentDepositorsDict
          );
        }

        await skyrocketPriceAndCheckAllTrovesSafe();

        const totalUSDDDepositsBeforeWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsBeforeWithdrawals = await stabilityPool.getETH();

        await attemptWithdrawAllDeposits(currentDepositors);

        const totalUSDDDepositsAfterWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsAfterWithdrawals = await stabilityPool.getETH();

        console.log(
          `Total USDD deposits before any withdrawals: ${totalUSDDDepositsBeforeWithdrawals}`
        );
        console.log(`Total ETH rewards before any withdrawals: ${totalETHRewardsBeforeWithdrawals}`);

        console.log(
          `Remaining USDD deposits after withdrawals: ${totalUSDDDepositsAfterWithdrawals}`
        );
        console.log(`Remaining ETH rewards after withdrawals: ${totalETHRewardsAfterWithdrawals}`);

        console.log(`current depositors length: ${currentDepositors.length}`);
        console.log(`remaining defaulters length: ${remainingDefaulters.length}`);
      });

      it("Defaulters' Collateral in range [1e6, 1e8]. SP Deposits in range [1e8 1e10]. ETH:USD = 100", async () => {
        // whale adds coll that holds TCR > 150%
        await borrowerOperations.openTrove(0, 0, whale, whale, { from: whale, value: dec(5, 29) });

        // price drops, all L liquidateable
        const numberOfOps = 5;
        const defaulterAccounts = accounts.slice(1, numberOfOps);
        const depositorAccounts = accounts.slice(numberOfOps + 1, numberOfOps * 2);

        const defaulterCollMin = 1000000;
        const defaulterCollMax = 100000000;
        const defaulterUSDDProportionMin = 91;
        const defaulterUSDDProportionMax = 180;

        const depositorCollMin = 1000000;
        const depositorCollMax = 100000000;
        const depositorUSDDProportionMin = 100;
        const depositorUSDDProportionMax = 100;

        const remainingDefaulters = [...defaulterAccounts];
        const currentDepositors = [];
        const liquidatedAccountsDict = {};
        const currentDepositorsDict = {};

        // setup:
        // account set L all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          defaulterCollMin,
          defaulterCollMax,
          defaulterAccounts,
          contracts,
          defaulterUSDDProportionMin,
          defaulterUSDDProportionMax
        );

        // account set S all add coll and withdraw USDD
        await th.openTrove_allAccounts_randomETH_randomUSDD(
          depositorCollMin,
          depositorCollMax,
          depositorAccounts,
          contracts,
          depositorUSDDProportionMin,
          depositorUSDDProportionMax
        );

        // price drops, all L liquidateable
        await priceFeed.setPrice(dec(100, 18));

        // Random sequence of operations: liquidations and SP deposits
        for (i = 0; i < numberOfOps; i++) {
          await randomOperation(
            depositorAccounts,
            remainingDefaulters,
            currentDepositors,
            liquidatedAccountsDict,
            currentDepositorsDict
          );
        }

        await skyrocketPriceAndCheckAllTrovesSafe();

        const totalUSDDDepositsBeforeWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsBeforeWithdrawals = await stabilityPool.getETH();

        await attemptWithdrawAllDeposits(currentDepositors);

        const totalUSDDDepositsAfterWithdrawals = await stabilityPool.getTotalUSDDDeposits();
        const totalETHRewardsAfterWithdrawals = await stabilityPool.getETH();

        console.log(
          `Total USDD deposits before any withdrawals: ${totalUSDDDepositsBeforeWithdrawals}`
        );
        console.log(`Total ETH rewards before any withdrawals: ${totalETHRewardsBeforeWithdrawals}`);

        console.log(
          `Remaining USDD deposits after withdrawals: ${totalUSDDDepositsAfterWithdrawals}`
        );
        console.log(`Remaining ETH rewards after withdrawals: ${totalETHRewardsAfterWithdrawals}`);

        console.log(`current depositors length: ${currentDepositors.length}`);
        console.log(`remaining defaulters length: ${remainingDefaulters.length}`);
      });
    });
  }
);