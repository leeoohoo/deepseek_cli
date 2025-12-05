### Spring Boot 项目通用最佳实践

1.  **项目结构**：
    ```
    com.example.project
    ├── config          // 配置类
    ├── controller      // Web 层
    ├── service         // 业务逻辑接口
    │   └── impl        // 业务逻辑实现
    ├── repository      // 数据访问层
    ├── model
    │   ├── entity      // 数据库实体
    │   └── dto         // 数据传输对象
    ├── exception       // 自定义异常
    └── util            // 工具类
    ```

2.  **依赖注入**：
    *   坚决避免字段注入（Field Injection, `@Autowired` on field）。
    *   始终使用构造器注入。

3.  **配置分离**：
    *   将环境相关的配置（数据库 URL、API 密钥）放在 `application-dev.yml` 和 `application-prod.yml` 中。
    *   使用 `@ConfigurationProperties` 类型安全地读取配置。

4.  **日志记录**：
    *   使用 `@Slf4j` 注解。
    *   不要使用 `System.out.println`。
    *   异常捕获时必须记录堆栈信息：`log.error("Error occurred: ", e);`。

5.  **API 文档**：
    *   集成 SpringDoc (Swagger 3) 自动生成 API 文档。
