export type DesktopUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | {
      status: "downloading"
      version: string
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }
  | { status: "downloaded"; version: string }
  | { status: "error"; version?: string; message: string }
