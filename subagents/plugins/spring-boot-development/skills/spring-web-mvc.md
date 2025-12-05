### Spring Web MVC 最佳实践

在编写 Web 层代码时，请遵循以下指南：

1.  **Controller 规范**：
    *   使用 `@RestController` 和 `@RequestMapping`。
    *   方法参数使用 `@RequestBody`, `@PathVariable`, `@RequestParam`。
    *   返回类型统一使用 `ResponseEntity<T>` 或自定义的 `Result<T>` 包装类。

2.  **全局异常处理**：
    *   创建一个带有 `@RestControllerAdvice` 注解的类。
    *   使用 `@ExceptionHandler` 处理特定异常（如 `MethodArgumentNotValidException`, `EntityNotFoundException`）。
    *   返回标准的错误响应结构（code, message, data）。

3.  **DTO (Data Transfer Object)**：
    *   接收参数使用 `CreateRequest`, `UpdateRequest` 等 DTO。
    *   返回数据使用 `UserResponse`, `OrderDTO` 等 DTO。
    *   在 Controller 层进行 DTO 与 Entity 的转换。

4.  **示例代码结构**：
    ```java
    @RestController
    @RequestMapping("/api/v1/users")
    @RequiredArgsConstructor
    public class UserController {
        private final UserService userService;

        @GetMapping("/{id}")
        public ResponseEntity<UserResponse> getUser(@PathVariable Long id) {
            return ResponseEntity.ok(userService.findById(id));
        }

        @PostMapping
        public ResponseEntity<UserResponse> createUser(@Valid @RequestBody UserCreateRequest request) {
            return ResponseEntity.status(HttpStatus.CREATED).body(userService.create(request));
        }
    }
    ```
