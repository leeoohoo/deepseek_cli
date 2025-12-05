### Spring Data JPA 最佳实践

在处理数据持久化时，请遵循以下指南：

1.  **Entity 定义**：
    *   使用 `@Entity` 和 `@Table` 注解。
    *   主键使用 `@Id` 和 `@GeneratedValue(strategy = GenerationType.IDENTITY)`。
    *   使用 `@Column` 定义字段约束（nullable, length）。
    *   使用 `@ManyToOne(fetch = FetchType.LAZY)` 避免 N+1 问题。
    *   利用 Lombok 的 `@Getter`, `@Setter` (避免在 Entity 上使用 `@Data`，因为它会生成 `hashCode` 和 `equals`，可能导致性能问题或循环引用)。

2.  **Repository 接口**：
    *   继承 `JpaRepository<Entity, Long>`。
    *   优先使用方法命名查询（Derived Query Methods）。
    *   复杂查询使用 `@Query` (JPQL) 或 `Specification`。

3.  **事务管理**：
    *   在 Service 层方法上使用 `@Transactional(readOnly = true)` 优化查询性能。
    *   在涉及写操作的方法上使用 `@Transactional`。

4.  **示例代码结构**：
    ```java
    @Entity
    @Table(name = "users")
    @Getter
    @Setter
    @NoArgsConstructor
    public class User {
        @Id
        @GeneratedValue(strategy = GenerationType.IDENTITY)
        private Long id;

        @Column(nullable = false, unique = true)
        private String email;
    }

    public interface UserRepository extends JpaRepository<User, Long> {
        Optional<User> findByEmail(String email);
        
        @Query("SELECT u FROM User u WHERE u.status = :status")
        List<User> findAllByStatus(@Param("status") UserStatus status);
    }
    ```
