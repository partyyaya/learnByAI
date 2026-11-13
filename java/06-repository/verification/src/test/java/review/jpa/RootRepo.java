package review.jpa;
import org.springframework.data.jpa.repository.JpaRepository;
public interface RootRepo extends JpaRepository<OrderEntity,String> {}
