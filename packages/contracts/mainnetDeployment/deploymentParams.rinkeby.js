const externalAddrs = {
  // https://data.chain.link/eth-usd
  CHAINLINK_ETHUSD_PROXY: "0x8A753747A1Fa494EC906cE90E9f37563A8AF630e",
  // https://docs.tellor.io/tellor/integration/reference-page
  TELLOR_MASTER: "0x20374E579832859f180536A69093A126Db1c8aE9",
  // https://uniswap.org/docs/v2/smart-contracts/factory/
  UNISWAP_V2_FACTORY: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  UNIWAP_V2_ROUTER02: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  WETH_ERC20: "0xc778417e063141139fce010982780140aa0cd5ab",
  AAB_ERC20: "0x3e792ad976409933A8FdfF65f3d2d894fE45405c",
};

const liquityAddrsTest = {
  DEPLOYER: "0x66aB6D9362d4F35596279692F0251Db635165871" // Mainnet test deployment address
}

const liquityAddrs = {
  DEPLOYER: "0x8B0a2D45aC9D4BaCa1589EF82eC6A2C7c4Ef69Dc",
};


const OUTPUT_FILE = './mainnetDeployment/rinkebyDeploymentOutput.json'

const delay = ms => new Promise(res => setTimeout(res, ms));
const waitFunction = async () => {
  return delay(90000) // wait 90s
}

const GAS_PRICE = 1000000000 // 1 Gwei
const TX_CONFIRMATIONS = 1

const ETHERSCAN_BASE_URL = 'https://rinkeby.etherscan.io/address'

module.exports = {
  externalAddrs,
  liquityAddrs,
  OUTPUT_FILE,
  waitFunction,
  GAS_PRICE,
  TX_CONFIRMATIONS,
  ETHERSCAN_BASE_URL,
};
