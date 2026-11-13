package review.jpa;
import jakarta.persistence.*;import java.io.Serializable;import java.util.*;
@Entity @Table(name="jpa_lines") @IdClass(OrderLineEntity.Key.class)
public class OrderLineEntity {
 @Id @ManyToOne @JoinColumn(name="order_id") OrderEntity order;
 @Id int lineNo;String productId;int quantity;long unitPriceMinor;String currency;
 protected OrderLineEntity(){}
 public OrderLineEntity(int lineNo,String productId,int quantity,long unitPriceMinor,String currency){this.lineNo=lineNo;this.productId=productId;this.quantity=quantity;this.unitPriceMinor=unitPriceMinor;this.currency=currency;}
 public String getProductId(){return productId;}
 public static class Key implements Serializable {
 public String order;public int lineNo;public Key(){}
 public boolean equals(Object o){return o instanceof Key k&&Objects.equals(order,k.order)&&lineNo==k.lineNo;}
 public int hashCode(){return Objects.hash(order,lineNo);}
 }
}
