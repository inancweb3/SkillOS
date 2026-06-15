// ───────────────────────────────────────────────────────────────────────────
// @skillos/ui — client-side React components + browser utilities.
//
// Safe to import from client components in any app/*.
// ───────────────────────────────────────────────────────────────────────────

export * from "./utils";
export * from "./api-client";
export { apiUrl } from "./apiUrl";
export { wagmiConfig } from "./wagmi";
export { Providers } from "./Providers";
export { Timer } from "./Timer";
export { WalletButton } from "./WalletButton";
export { PopupHint, type PopupHintProps } from "./PopupHint";
export { AddressDisplay, type AddressDisplayProps } from "./AddressDisplay";
export {
  useBasename,
  type BasenameStatus,
  type UseBasenameReturn,
} from "./useBasename";
export { ModeChooser, type ModeChooserProps } from "./ModeChooser";
export { DuelComingSoon } from "./DuelComingSoon";
export {
  selectDuelResultBranch,
  type DuelResultBranch,
  type DuelResultBranchInput,
} from "./duel-result-branch";
export {
  DuelResultCard,
  type DuelResultCardProps,
} from "./DuelResultCard";
export { useIsEmbedded } from "./useIsEmbedded";
export { Header, type HeaderProps } from "./Header";
export { SkillOSWordmark, type SkillOSWordmarkProps } from "./SkillOSWordmark";
export { SoloResultCard, type SoloResultCardProps } from "./SoloResultCard";
export {
  TournamentClassPill,
  type TournamentClassPillProps,
} from "./TournamentClassPill";
export {
  ExclusionTooltip,
  type ExclusionTooltipProps,
  type ExclusionReason,
} from "./ExclusionTooltip";
export { BuilderMark, type BuilderMarkProps } from "./BuilderMark";
export { useMiniAppReady } from "./useMiniAppReady";
export { ReadyMarker } from "./ReadyMarker";
export { EmbedWalletFallback } from "./EmbedWalletFallback";
export {
  ALLOWED_CONNECTORS,
  EXTENSION_PROFILE_HEADER,
  evaluateExtensionProfile,
  type AllowedConnector,
  type ExtensionProfile,
  type TournamentClass,
} from "./extension-whitelist";
export {
  ExtensionWarningModal,
  type ExtensionWarningModalProps,
} from "./ExtensionWarningModal";
export {
  COACH_MODEL_DISPLAY,
  RECAP_MODEL_DISPLAY,
  ANTICHEAT_MODEL_DISPLAY,
} from "./models";
export {
  useSoloRetry,
  type UseSoloRetryStatus,
  type UseSoloRetryParams,
  type UseSoloRetryReturn,
  type SoloEligibility,
  type SoloSubmitResponse,
} from "./useSoloRetry";
