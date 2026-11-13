package review;
import com.example.lab.shop.*;import com.example.lab.ch08.Dyn;
import java.util.*;import java.util.function.Function;import java.time.Instant;import java.math.BigDecimal;
final class CriteriaCases {
    static List<OrderSearchCriteria> combinations(){
        return Dyn.combinations(OrderSearchCriteria.empty(),List.<Function<OrderSearchCriteria,OrderSearchCriteria>>of(
            c->new OrderSearchCriteria(OrderStatus.PENDING,c.customerKeyword(),c.from(),c.to(),c.minAmount()),
            c->new OrderSearchCriteria(c.status(),"customer",c.from(),c.to(),c.minAmount()),
            c->new OrderSearchCriteria(c.status(),c.customerKeyword(),Instant.parse("2026-09-01T00:05:00Z"),c.to(),c.minAmount()),
            c->new OrderSearchCriteria(c.status(),c.customerKeyword(),c.from(),Instant.parse("2026-09-01T00:20:00Z"),c.minAmount()),
            c->new OrderSearchCriteria(c.status(),c.customerKeyword(),c.from(),c.to(),new BigDecimal("110"))));
    }
}