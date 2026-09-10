export function dismissStartupLoading(): void {
  if (typeof document === "undefined") return
  document.getElementById("startup-loading")?.remove()
}
