import { buildGitNodes } from "./layoutNodes/buildGitNodes";
import type { GitLayoutNodesOptions } from "./layoutNodes/buildGitNodes";
import { buildPrimaryNodes } from "./layoutNodes/buildPrimaryNodes";
import type { PrimaryLayoutNodesOptions } from "./layoutNodes/buildPrimaryNodes";
import { buildSecondaryNodes } from "./layoutNodes/buildSecondaryNodes";
import type { SecondaryLayoutNodesOptions } from "./layoutNodes/buildSecondaryNodes";
import type { LayoutNodesOptions, LayoutNodesResult } from "./layoutNodes/types";

export function useLayoutNodes(options: LayoutNodesOptions): LayoutNodesResult {
  const primaryOptions: PrimaryLayoutNodesOptions = options;
  const gitOptions: GitLayoutNodesOptions = options;
  const secondaryOptions: SecondaryLayoutNodesOptions = options;

  return {
    ...buildPrimaryNodes(primaryOptions),
    ...buildGitNodes(gitOptions),
    ...buildSecondaryNodes(secondaryOptions),
  };
}
