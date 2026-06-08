/** Minimal human-readable ABIs (ethers v6) for read-only LFJ LB access. */

// LBFactory v2.2 — pair enumeration.
export const LB_FACTORY_ABI = [
  "function getNumberOfLBPairs() view returns (uint256)",
  "function getLBPairAtIndex(uint256 index) view returns (address)",
];

// LBPair v2.2 — read-only state + LBToken (ERC1155-style share tokens per bin).
export const LB_PAIR_ABI = [
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getBinStep() view returns (uint16)",
  "function getActiveId() view returns (uint24)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getVariableFeeParameters() view returns (uint24 volatilityAccumulator, uint24 volatilityReference, uint24 idReference, uint40 timeOfLastUpdate)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
  // LBToken: liquidity shares minted to the LP, one fungible id per bin.
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function totalSupply(uint256 id) view returns (uint256)",
];

// LBRouter v2.2 — liquidity add/remove (the path for opening/closing positions).
export const LB_ROUTER_ABI = [
  "function addLiquidity((address tokenX, address tokenY, uint256 binStep, uint256 amountX, uint256 amountY, uint256 amountXMin, uint256 amountYMin, uint256 activeIdDesired, uint256 idSlippage, int256[] deltaIds, uint256[] distributionX, uint256[] distributionY, address to, address refundTo, uint256 deadline) liquidityParameters) returns (uint256 amountXAdded, uint256 amountYAdded, uint256 amountXLeft, uint256 amountYLeft, uint256[] depositIds, uint256[] liquidityMinted)",
  "function removeLiquidity(address tokenX, address tokenY, uint16 binStep, uint256 amountXMin, uint256 amountYMin, uint256[] ids, uint256[] amounts, address to, uint256 deadline) returns (uint256 amountX, uint256 amountY)",
];

// ERC20 — metadata + balances + approvals.
export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
