# @openharness/protocol

OpenHarness 客户端和服务端共同使用的数据格式。

这个包只包含 Session、Run、Message、Permission、Schedule、事件和运行配置的数据定义与纯函数。它不读取文件，不连接数据库，也不依赖 Node.js，可以被浏览器、IDE webview、TUI、Desktop 和服务端共同使用。
