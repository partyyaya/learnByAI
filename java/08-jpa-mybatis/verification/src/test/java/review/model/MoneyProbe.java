package review.model;
import jakarta.persistence.*;import java.math.BigDecimal;
@Entity @Table(name="money_probe")
public class MoneyProbe {
 @Id public Long id;
 public BigDecimal bare;
 @Column(precision=10,scale=2) public BigDecimal annotated;
 @Column(nullable=false) public String required;
 public MoneyProbe(){}
 public MoneyProbe(long id,BigDecimal value,String required){this.id=id;this.bare=value;this.annotated=value;this.required=required;}
}
