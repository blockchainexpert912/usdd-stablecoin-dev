import pytest

from brownie import *
from accounts import *
from helpers import *
from simulation_helpers import *

class Contracts: pass


def setAddresses(contracts):
    contracts.sortedTroves.setParams(
        MAX_BYTES_32,
        contracts.troveManager.address,
        contracts.borrowerOperations.address,
        { 'from': accounts[0] }
    )

    contracts.troveManager.setAddresses(
        contracts.borrowerOperations.address,
        contracts.activePool.address,
        contracts.defaultPool.address,
        contracts.stabilityPool.address,
        contracts.gasPool.address,
        contracts.collSurplusPool.address,
        contracts.priceFeedTestnet.address,
        contracts.lusdToken.address,
        contracts.sortedTroves.address,
        contracts.lqtyToken.address,
        contracts.lqtyStaking.address,
        { 'from': accounts[0] }
    )

    contracts.borrowerOperations.setAddresses(
        contracts.troveManager.address,
        contracts.activePool.address,
        contracts.defaultPool.address,
        contracts.stabilityPool.address,
        contracts.gasPool.address,
        contracts.collSurplusPool.address,
        contracts.priceFeedTestnet.address,
        contracts.sortedTroves.address,
        contracts.lusdToken.address,
        contracts.lqtyStaking.address,
        { 'from': accounts[0] }
    )

    contracts.stabilityPool.setAddresses(
        contracts.borrowerOperations.address,
        contracts.troveManager.address,
        contracts.activePool.address,
        contracts.lusdToken.address,
        contracts.sortedTroves.address,
        contracts.priceFeedTestnet.address,
        contracts.communityIssuance.address,
        { 'from': accounts[0] }
    )

    contracts.activePool.setAddresses(
        contracts.borrowerOperations.address,
        contracts.troveManager.address,
        contracts.stabilityPool.address,
        contracts.defaultPool.address,
        { 'from': accounts[0] }
    )

    contracts.defaultPool.setAddresses(
        contracts.troveManager.address,
        contracts.activePool.address,
        { 'from': accounts[0] }
    )

    contracts.collSurplusPool.setAddresses(
        contracts.borrowerOperations.address,
        contracts.troveManager.address,
        contracts.activePool.address,
        { 'from': accounts[0] }
    )

    contracts.hintHelpers.setAddresses(
        contracts.sortedTroves.address,
        contracts.troveManager.address,
        { 'from': accounts[0] }
    )

    # LQTY
    contracts.lqtyStaking.setAddresses(
        contracts.lqtyToken.address,
        contracts.lusdToken.address,
        contracts.troveManager.address,
        contracts.borrowerOperations.address,
        contracts.activePool.address,
        { 'from': accounts[0] }
    )

    contracts.communityIssuance.setAddresses(
        contracts.lqtyToken.address,
        contracts.stabilityPool.address,
        { 'from': accounts[0] }
    )

@pytest.fixture
def add_accounts():
    if network.show_active() != 'development':
        print("Importing accounts...")
        import_accounts(accounts)

@pytest.fixture
def contracts():
    contracts = Contracts()

    contracts.priceFeedTestnet = PriceFeedTestnet.deploy({ 'from': accounts[0] })
    contracts.sortedTroves = SortedTroves.deploy({ 'from': accounts[0] })
    contracts.troveManager = TroveManager.deploy({ 'from': accounts[0] })
    contracts.activePool = ActivePool.deploy({ 'from': accounts[0] })
    contracts.stabilityPool = StabilityPool.deploy({ 'from': accounts[0] })
    contracts.gasPool = GasPool.deploy({ 'from': accounts[0] })
    contracts.defaultPool = DefaultPool.deploy({ 'from': accounts[0] })
    contracts.collSurplusPool = CollSurplusPool.deploy({ 'from': accounts[0] })
    contracts.borrowerOperations = BorrowerOperations.deploy({ 'from': accounts[0] })
    contracts.hintHelpers = HintHelpers.deploy({ 'from': accounts[0] })
    contracts.lusdToken = LUSDToken.deploy(
        contracts.troveManager.address,
        contracts.stabilityPool.address,
        contracts.borrowerOperations.address,
        { 'from': accounts[0] }
    )
    # LQTY
    contracts.lqtyStaking = LQTYStaking.deploy({ 'from': accounts[0] })
    contracts.communityIssuance = CommunityIssuance.deploy({ 'from': accounts[0] })
    contracts.lqtyToken = LQTYToken.deploy(
        contracts.communityIssuance.address,
        contracts.lqtyStaking.address,
        { 'from': accounts[0] }
    )

    setAddresses(contracts)

    return contracts

@pytest.fixture
def print_expectations():
    ether_price_one_year = price_ether_initial * (1 + drift_ether)**8760
    print("Expected ether price at the end of the year: $", ether_price_one_year)

    print("\n Open troves")
    print("E(Q_t^e)    = ", collateral_gamma_k * collateral_gamma_theta)
    print("SD(Q_t^e)   = ", collateral_gamma_k**(0.5) * collateral_gamma_theta)
    print("E(CR^*(i))  = ", (target_cr_a + target_cr_b * target_cr_chi_square_df) * 100, "%")
    print("SD(CR^*(i)) = ", target_cr_b * (2*target_cr_chi_square_df)**(1/2) * 100, "%")
    print("E(tau)      = ", rational_inattention_gamma_k * rational_inattention_gamma_theta * 100, "%")
    print("SD(tau)     = ", rational_inattention_gamma_k**(0.5) * rational_inattention_gamma_theta * 100, "%")
    print("\n")

def _test_test(contracts):
    print(len(accounts))
    contracts.borrowerOperations.openTrove(Wei(1e18), Wei(2000e18), ZERO_ADDRESS, ZERO_ADDRESS,
                                           { 'from': accounts[1], 'value': Wei("100 ether") })

    #assert False

"""# Simulation Program
**Sequence of events**

> In each period, the following events occur sequentially


* exogenous ether price input
* trove liquidation
* return of the previous period's stability pool determined (liquidation gain & airdropped LQTY gain)
* trove closure
* trove adjustment
* open troves
* issuance fee
* trove pool formed
* LUSD supply determined
* LUSD stability pool demand determined
* LUSD liquidity pool demand determined
* LUSD price determined
* redemption & redemption fee
* LQTY pool return determined
"""
def test_run_simulation(add_accounts, contracts, print_expectations):
    MIN_NET_DEBT = contracts.troveManager.MIN_NET_DEBT() / 1e18

    price = contracts.priceFeedTestnet.setPrice(floatToWei(price_ether[0]), { 'from': accounts[0] })
    # whale
    contracts.borrowerOperations.openTrove(MAX_FEE, Wei(10e24), ZERO_ADDRESS, ZERO_ADDRESS,
                                           { 'from': accounts[0], 'value': Wei("30000 ether") })
    contracts.stabilityPool.provideToSP(floatToWei(stability_initial), ZERO_ADDRESS, { 'from': accounts[0] })

    active_accounts = []
    inactive_accounts = [*range(1, len(accounts))]

    price_LUSD = 1

    data = {"airdrop_gain": [0] * n_sim, "liquidation_gain": [0] * n_sim}
    total_lusd_redempted = 0
    total_coll_added = 0
    total_coll_liquidated = 0

    print(f"Accounts: {len(accounts)}")
    print(f"Network: {network.show_active()}")

    logGlobalState(contracts)

    #Simulation Process
    for index in range(1, n_sim):
        print('\n  --> Iteration', index)
        print('  -------------------\n')
        #exogenous ether price input
        price_ether_current = price_ether[index]
        price = contracts.priceFeedTestnet.setPrice(floatToWei(price_ether_current), { 'from': accounts[0] })
        #price_LQTY_previous = data.loc[index-1,'price_LQTY']

        #trove liquidation & return of stability pool
        result_liquidation = liquidate_troves(accounts, contracts, active_accounts, inactive_accounts, price_ether_current, price_LUSD, data, index)
        total_coll_liquidated = total_coll_liquidated + result_liquidation[0]
        return_stability = result_liquidation[1]

        #close troves
        result_close = close_troves(accounts, contracts, active_accounts, inactive_accounts, price_ether_current, price_LUSD, index)

        #adjust troves
        coll_added_adjust = adjust_troves(accounts, contracts, active_accounts, inactive_accounts, price_ether_current, index)

        #open troves
        coll_added_open = open_troves(accounts, contracts, active_accounts, inactive_accounts, price_ether_current, price_LUSD, index)
        total_coll_added = total_coll_added + coll_added_adjust + coll_added_open
        #active_accounts.sort(key=lambda a : a.get('CR_initial'))

        #Stability Pool
        stability_update(accounts, contracts, return_stability, index)

        #Calculating Price, Liquidity Pool, and Redemption
        [price_LUSD, redemption_pool] = price_stabilizer(accounts, contracts, active_accounts, price_LUSD, index)
        total_lusd_redempted = total_lusd_redempted + redemption_pool
        print('LUSD price', price_LUSD)

        """
        #LQTY Market
        result_LQTY = LQTY_market(index, data)
        price_LQTY_current = result_LQTY[0]
        annualized_earning = result_LQTY[1]
        MC_LQTY_current = result_LQTY[2]
        """

        logGlobalState(contracts)
        print('Total redempted ', total_lusd_redempted)
        print('Total ETH added ', total_coll_added)
        print('Total ETH liquid', total_coll_liquidated)
        print(f'Ratio ETH liquid {100 * total_coll_liquidated / total_coll_added}%')
        print(' ----------------------\n')

        assert price_LUSD > 0
