# @openharness/protocol

OpenHarness 客户端和服务端共同使用的数据格式。

这个包只包含 Session、Run、Message、Permission、Schedule、Job、Terminal、事件和运行配置的数据定义与纯函数。它不读取文件，不连接数据库，也不依赖 Node.js，可以被浏览器、IDE webview、TUI、Desktop 和服务端共同使用。

HTTP 接入层在调用应用前，也使用这里的解析函数检查 Session、Prompt、Permission 和 Schedule 请求。字段类型不对时会得到带稳定 `code` 的错误，例如 `invalid_request`，上层产品不需要依赖某一句报错文字来判断错误类别。

客户端收到 Session Snapshot、Event、Job 或 Terminal 数据后也会做实际检查。服务端即使返回了合法 JSON，只要里面的字段不符合协议，客户端就会报告 `invalid_protocol_data` 和具体字段路径，不会让错误数据继续进入 reducer 或界面。
