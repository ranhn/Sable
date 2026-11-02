import { translate as swt } from "@/i18n/runtime";
// Sidebar Variant
export const SIDEBAR_VARIANT_OPTIONS = [
  { get label() { return swt("english.e031"); }, value: "sidebar" },
  { get label() { return swt("english.e029"); }, value: "inset" },
  { get label() { return swt("english.e033"); }, value: "floating" },
] as const;
export const SIDEBAR_VARIANT_VALUES = SIDEBAR_VARIANT_OPTIONS.map((v) => v.value);
export type SidebarVariant = (typeof SIDEBAR_VARIANT_VALUES)[number];

// Sidebar Collapsible
export const SIDEBAR_COLLAPSIBLE_OPTIONS = [
  { get label() { return swt("english.e036"); }, value: "icon" },
  { get label() { return swt("english.e187"); }, value: "offcanvas" },
] as const;
export const SIDEBAR_COLLAPSIBLE_VALUES = SIDEBAR_COLLAPSIBLE_OPTIONS.map((v) => v.value);
export type SidebarCollapsible = (typeof SIDEBAR_COLLAPSIBLE_VALUES)[number];

// Content Layout
export const CONTENT_LAYOUT_OPTIONS = [
  { get label() { return swt("english.e019"); }, value: "centered" },
  { get label() { return swt("english.e021"); }, value: "full-width" },
] as const;
export const CONTENT_LAYOUT_VALUES = CONTENT_LAYOUT_OPTIONS.map((v) => v.value);
export type ContentLayout = (typeof CONTENT_LAYOUT_VALUES)[number];

// Navbar Style
export const NAVBAR_STYLE_OPTIONS = [
  { get label() { return swt("english.e024"); }, value: "sticky" },
  { get label() { return swt("english.e026"); }, value: "scroll" },
] as const;
export const NAVBAR_STYLE_VALUES = NAVBAR_STYLE_OPTIONS.map((v) => v.value);
export type NavbarStyle = (typeof NAVBAR_STYLE_VALUES)[number];
