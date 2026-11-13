package review.jpa;
import example.shop.order.application.port.*;import example.shop.order.domain.*;import example.shop.common.money.Money;
import jakarta.persistence.EntityManager;import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.transaction.annotation.*;
import java.time.Instant;import java.util.*;
public class JpaAdapter implements OrderRepository {
 final RootRepo repo;final EntityManager em;
 public JpaAdapter(RootRepo repo,EntityManager em){this.repo=repo;this.em=em;}
 // COURSE_SAVE
 static List<OrderLineEntity> toLineEntities(Order order){var result=new ArrayList<OrderLineEntity>();int n=0;for(var l:order.lines())result.add(new OrderLineEntity(++n,l.productId(),l.quantity(),l.unitPrice().minorUnits(),l.unitPrice().currency().getCurrencyCode()));return result;}
 public Optional<Order> findById(String id){return repo.findById(id).map(e->Order.rehydrate(e.id,e.customerId,e.status,e.lines.stream().map(l->new OrderLine(l.productId,l.quantity,Money.ofMinorUnits(l.unitPriceMinor,l.currency))).toList(),Money.ofMinorUnits(e.totalMinor,e.currency),e.createdAt,e.version));}
 public String nextId(){return UUID.randomUUID().toString();}
 public void saveAll(Collection<Order> orders){orders.forEach(this::save);}
 public Optional<Order> findByIdVisibleTo(String id,Actor actor){throw new UnsupportedOperationException("outside this fixture's scope");}
 public List<Order> findExpiredPendingPayment(Instant now,int limit){throw new UnsupportedOperationException("outside this fixture's scope");}
 public long countByCustomerId(String id){throw new UnsupportedOperationException("outside this fixture's scope");}
}
