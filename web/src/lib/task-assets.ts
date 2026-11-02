import { translate as swt } from "@/i18n/runtime";
import type { NewAssetType } from "@/lib/types";

const ASSET_TYPE_LABELS: Record<NewAssetType, string> = {
  get app() { return swt("interface.m0144"); },
  get endpoint() { return swt("interface.m0218"); },
  ip: "IP",
  get root_domain() { return swt("interface.m0142"); },
  get service() { return swt("interface.m0145"); },
  get subdomain() { return swt("interface.m0143"); },
};

const TASK_ASSET_SOURCE_LABELS: Record<string, string> = {
  get agent() { return swt("interface.m2862"); },
  get anchor() { return swt("interface.m2863"); },
  get api() { return swt("interface.m2864"); },
  get company() { return swt("interface.m2865"); },
  get legacy() { return swt("interface.m2866"); },
  get manual() { return swt("interface.m2867"); },
  get system() { return swt("interface.m2868"); },
  get task() { return swt("interface.m2869"); },
};

export function taskAssetTypeLabel(type: NewAssetType): string {
  return ASSET_TYPE_LABELS[type];
}

export function taskAssetSourceLabel(source: string): string {
  return TASK_ASSET_SOURCE_LABELS[source] ?? source;
}
