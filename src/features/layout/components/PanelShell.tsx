import type { ReactNode } from "react";
import { isWebCompanionRuntime } from "../../../services/runtime";

import {
  PanelFrame,
  PanelHeader,
} from "../../design-system/components/panel/PanelPrimitives";
import {
  PanelTabs,
  type PanelTab,
  type PanelTabId,
  defaultPanelTabs,
  webPanelTabs,
} from "./PanelTabs";

type PanelShellProps = {
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  tabs?: PanelTab[];
  className?: string;
  headerClassName?: string;
  headerRight?: ReactNode;
  search?: ReactNode;
  children: ReactNode;
};

export function PanelShell({
  filePanelMode,
  onFilePanelModeChange,
  tabs,
  className,
  headerClassName,
  headerRight,
  search,
  children,
}: PanelShellProps) {
  const resolvedTabs = tabs ?? (isWebCompanionRuntime() ? webPanelTabs : defaultPanelTabs);
  return (
    <PanelFrame className={className}>
      <PanelHeader className={headerClassName}>
        <PanelTabs active={filePanelMode} onSelect={onFilePanelModeChange} tabs={resolvedTabs} />
        {headerRight}
      </PanelHeader>
      {search}
      {children}
    </PanelFrame>
  );
}
