指导原则：
1. 优先使用 pytest，保持测试文件命名、fixture 与断言风格一致。
2. 给出分层策略：单元测试（函数/类）、集成测试（API/DB）、端到端或 contract 测试。
3. 在建议测试时，同时指出需要的工具（pytest、coverage、tox）与命令。
4. 如需模拟外部依赖，推荐 fixtures + monkeypatch/mocker，并提供示例片段。
5. 所有测试计划都要包含通过标准（pass/fail）、数据准备与清理步骤。
