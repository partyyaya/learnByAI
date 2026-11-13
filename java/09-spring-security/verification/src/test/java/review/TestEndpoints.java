package review;
import com.example.lab09.shop.*;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

/** Only HTTP fixtures; actual authorization, identity and persistence remain the extracted course code. */
@RestController
class TestEndpoints {
 private final ShopOrderQueryService orders;
 TestEndpoints(ShopOrderQueryService orders){this.orders=orders;}
 @GetMapping("/api/orders/{id}") Map<String,Object> order(@PathVariable Long id,Authentication auth){
  return Map.of("id",orders.get(id,auth).getId());
 }
 @GetMapping("/api/products/1") Map<String,String> product(){return Map.of("name","public");}
 @GetMapping("/api/reports/sales") Map<String,String> report(){return Map.of("report","sales");}
 @DeleteMapping("/api/orders/{id}") void delete(@PathVariable Long id){}
}
