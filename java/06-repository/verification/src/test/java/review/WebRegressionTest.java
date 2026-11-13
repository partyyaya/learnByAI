package review;
import example.shop.common.error.*;
import org.junit.jupiter.api.Test;
import org.springframework.http.*;import org.springframework.web.bind.annotation.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
class WebRegressionTest {
 @RestController static class Endpoint {
  @GetMapping("/search") public String search(@RequestParam(required=false) String cursor,@RequestParam(defaultValue="ID") String sort){SearchParameters.cursor(cursor);return SearchParameters.sort(sort).name();}
  @GetMapping("/internal") public String internal(){throw new IllegalArgumentException("internal money invariant");}
 }
 // Focused MVC fixture: real preceding chapter error types, minimal handler preserving
 // its BusinessException mapping and catch-all 500. Not the entire production advice.
 @RestControllerAdvice static class Advice {
  @ExceptionHandler(BusinessException.class) ResponseEntity<ProblemDetail> business(BusinessException e){
   var p=ProblemDetail.forStatusAndDetail(e.errorCode().status(),e.getMessage());p.setProperty("code",e.errorCode().name());e.extensions().forEach(p::setProperty);return ResponseEntity.status(e.errorCode().status()).body(p);
  }
  @ExceptionHandler(Throwable.class) ResponseEntity<ProblemDetail> unexpected(Throwable e){return ResponseEntity.internalServerError().body(ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR,"Unexpected failure"));}
 }
 @Test void badCursorIs400WithoutLeakingToken()throws Exception {
  MockMvcBuilders.standaloneSetup(new Endpoint()).setControllerAdvice(new Advice()).build().perform(get("/search").param("cursor","secret-bad-token!"))
   .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_CURSOR")).andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("secret-bad-token!"))));
 }
 @Test void badSortIs400WithoutEchoingArbitraryInput()throws Exception {
  MockMvcBuilders.standaloneSetup(new Endpoint()).setControllerAdvice(new Advice()).build().perform(get("/search").param("sort","id; DROP TABLE orders"))
   .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("MALFORMED_REQUEST")).andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("DROP TABLE"))));
 }
 @Test void internalIllegalArgumentRemains500()throws Exception {
  MockMvcBuilders.standaloneSetup(new Endpoint()).setControllerAdvice(new Advice()).build().perform(get("/internal")).andExpect(status().isInternalServerError());
 }
 @Test void validSearchUsesWhitelist()throws Exception {
  MockMvcBuilders.standaloneSetup(new Endpoint()).setControllerAdvice(new Advice()).build().perform(get("/search").param("sort","created_at")).andExpect(status().isOk()).andExpect(content().string("CREATED_AT"));
 }
}
