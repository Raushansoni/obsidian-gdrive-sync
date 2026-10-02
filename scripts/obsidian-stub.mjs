/** Minimal Obsidian stub so pairing tests can bundle without the app. */
export class Plugin {}
export class PluginSettingTab {}
export class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return this; }
  addToggle() { return this; }
  addTextArea() { return this; }
}
export class Notice {}
export const Platform = { isMobile: false, isDesktop: true };
export function requestUrl() {
  throw new Error("requestUrl is not available in tests");
}
export function addIcon() {}
export class TAbstractFile {}
