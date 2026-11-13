package review.jpa;
import jakarta.persistence.*;
import example.shop.order.domain.OrderStatus;
import java.time.Instant;import java.util.*;
@Entity @Table(name="jpa_orders")
public class OrderEntity {
 @Id String id; String customerId;
 @Enumerated(EnumType.STRING) OrderStatus status;
 long totalMinor;String currency;Instant createdAt;
 @Version long version;
 @OneToMany(mappedBy="order",cascade=CascadeType.ALL,orphanRemoval=true)
 @OrderBy("lineNo") List<OrderLineEntity> lines=new ArrayList<>();
 protected OrderEntity(){}
 public OrderEntity(String id,String customerId,OrderStatus status,long totalMinor,String currency,Instant createdAt){this.id=id;this.customerId=customerId;this.status=status;this.totalMinor=totalMinor;this.currency=currency;this.createdAt=createdAt;}
 public void replaceLines(List<OrderLineEntity> incoming){lines.clear();incoming.forEach(l->{l.order=this;lines.add(l);});}
 public List<OrderLineEntity> getLines(){return lines;}
 public long getVersion(){return version;}
 public void setStatus(OrderStatus value){status=value;}
 public void setTotalMinor(long value){totalMinor=value;}
 public void setCurrency(String value){currency=value;}
}
