// ─── 列表/视口 ────────────────────────────────────────────────────────────────
/** 补全浮窗（命令 / 文件）和 DialogSelect 的最大可见行数 */
export const AC_VISIBLE_ITEMS = 10;

// ─── 上限 ────────────────────────────────────────────────────────────────────
/** 输入历史保留条数 */
export const HISTORY_LIMIT = 100;
/** Swarm 通知队列保留条数（slice tail） */
export const SWARM_NOTIFICATION_TAIL = 20;

// ─── 计时器 ──────────────────────────────────────────────────────────────────
/** 双击 Esc 取消：第一次 Esc 后提示的显示时长 (ms) */
export const ESC_HINT_TIMEOUT_MS = 2000;
/** Spinner 动画帧间隔 (ms) */
export const SPINNER_INTERVAL_MS = 100;

// ─── 布局 ────────────────────────────────────────────────────────────────────
/** 终端宽度达到此值时自动展开 Sidebar */
export const SIDEBAR_AUTO_OPEN_WIDTH = 110;
/** Footer cwd 缩略最大字符数 */
export const CWD_DISPLAY_MAX_LEN = 40;

// ─── 显示格式 ─────────────────────────────────────────────────────────────────
/** Token 计数超过此值时显示为 "Nk" */
export const TOKEN_K_THRESHOLD = 1000;
/** 多行输入框最大行高 */
export const TEXTAREA_MAX_LINES = 6;
