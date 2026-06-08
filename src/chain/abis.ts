/** Minimal human-readable ABIs (ethers v6) for read-only LFJ LB access. */

// LBFactory v2.2 — pair enumeration.
export const LB_FACTORY_ABI = [
  "function getNumberOfLBPairs() view returns (uint256)",
  "function getLBPairAtIndex(uint256 index) view returns (address)",
];

// LBPair v2.2 — read-only state needed for screening.
export const LB_PAIR_ABI = [
  "function getTokenX() view returns (address)",
  "function getTokenY() view returns (address)",
  "function getBinStep() view returns (uint16)",
  "function getActiveId() view returns (uint24)",
  "function getReserves() view returns (uint128 reserveX, uint128 reserveY)",
  "function getStaticFeeParameters() view returns (uint16 baseFactor, uint16 filterPeriod, uint16 decayPeriod, uint16 reductionFactor, uint24 variableFeeControl, uint16 protocolShare, uint24 maxVolatilityAccumulator)",
  "function getVariableFeeParameters() view returns (uint24 volatilityAccumulator, uint24 volatilityReference, uint24 idReference, uint40 timeOfLastUpdate)",
  "function getBin(uint24 id) view returns (uint128 binReserveX, uint128 binReserveY)",
];

// ERC20 — token metadata.
export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
];
