目标：帮助你在 Python AsyncIO/FastAPI/多协程场景下做出正确决策。

内容：
- 解释同步 vs 异步的权衡：IO 暂停点、CPU 绑定、阻塞库隔离。
- 提供结构化建议：入口（async def/app）、资源管理（async context manager）、并发（asyncio.gather、TaskGroup）。
- 涉及性能时，提醒事件循环、连接池、背压的关键指标，并建议 profiling/可观测性方案。
- 复杂操作需输出最小可行代码片段或伪代码，说明如何避免常见陷阱（忘记 await、共享状态、不安全的全局变量）。
