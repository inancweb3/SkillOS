// Re-export ABIs + addresses from the vendored copy of packages/contracts.
// See ./contracts-vendored/README.md for why this is vendored and when it
// gets reverted (ESM consistency cleanup PR, post-Sprint X3).

export {
  TOURNAMENT_POOL_ABI,
  SPONSORSHIP_MODULE_ABI,
  ERC20_ABI,
} from './contracts-vendored/abi.js';

export {
  TOURNAMENT_POOL_V21_ADDRESS,
  SPONSORSHIP_MODULE_ADDRESS,
  SPONSOR_RECEIPT_SBT_ADDRESS,
  USDC_ADDRESS,
  CHAIN_ID,
} from './contracts-vendored/addresses.js';
