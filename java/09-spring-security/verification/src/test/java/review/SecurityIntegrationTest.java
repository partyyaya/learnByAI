package review;
import com.example.lab09.shop.*;
import com.example.lab09.ch05.*;
import com.example.lab09.ch06.SocialAccountService;
import com.example.lab09.ch08.*;
import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.session.*;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.client.oidc.userinfo.OidcUserRequest;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.*;
import org.springframework.security.oauth2.core.oidc.*;
import org.springframework.security.oauth2.core.oidc.user.*;
import org.springframework.test.web.servlet.*;
import org.springframework.transaction.PlatformTransactionManager;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(classes=ReviewApplication.class) @AutoConfigureMockMvc
class SecurityIntegrationTest {
 @Autowired MockMvc mvc; @Autowired JdbcTemplate jdbc; @Autowired PasswordEncoder encoder;
 @Autowired AuthenticationManager am; @Autowired JwtService jwt; @Autowired RefreshTokenService refresh;
 @Autowired PlatformTransactionManager manager; @Autowired ShopUserDetailsService users;
 @Autowired ShopSessionAdmin sessions; @Autowired SessionRegistry registry;
 @Autowired SocialAccountService social; @Autowired ApplicationContext context;
 @Autowired OAuth2UserService<OidcUserRequest,OidcUser> oidc;
 @Autowired ClientRegistrationRepository clients; @Autowired NoteService notes;
 @Autowired ShopOrderService orders;
 static String hash;
 @BeforeEach void seed(){
  for(String table:List.of("audit_log","refresh_token","refresh_family","social_identity","user_role","role_permission","permission","app_role","authority","shop_order","note","app_user"))jdbc.update("DELETE FROM "+table);
  if(hash==null) hash=encoder.encode("pw");
  for(long id=1;id<=4;id++) jdbc.update("INSERT INTO app_user(id,username,password_hash,display_name) VALUES(?,?,?,?)",id,List.of("alice","bob","cs","admin").get((int)id-1),hash,"User");
  jdbc.update("INSERT INTO app_role(id,code,name) VALUES(1,'MEMBER','Member'),(2,'CS_AGENT','CS'),(3,'ADMIN','Admin')");
  String[] perms={"order:read","order:read:all","order:refund","order:delete","report:read","user:manage"};
  for(int i=0;i<perms.length;i++) jdbc.update("INSERT INTO permission(id,code,name) VALUES(?,?,?)",i+1,perms[i],perms[i]);
  jdbc.update("INSERT INTO user_role VALUES(1,1),(2,1),(3,2),(4,3)");
  jdbc.update("INSERT INTO role_permission VALUES(1,1),(2,1),(2,2),(2,3),(3,1),(3,2),(3,3),(3,4),(3,5),(3,6)");
  jdbc.update("INSERT INTO shop_order(id,owner_id,amount,status) VALUES(1001,1,1280,'PAID'),(1002,2,99000,'PAID')");
  for(Object p:registry.getAllPrincipals())for(SessionInformation s:registry.getAllSessions(p,true))registry.removeSessionInformation(s.getSessionId());
  SecurityContextHolder.clearContext();
 }
 @AfterEach void clear(){SecurityContextHolder.clearContext();}
 String token(String username){var u=(ShopUserDetailsService.ShopUserDetails)users.loadUserByUsername(username);return jwt.issue(u,u.userId(),u.tokenVersion());}
 void as(String username){SecurityContextHolder.getContext().setAuthentication(am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(username,"pw")));}
 long auditCount(String action,String outcome){return jdbc.queryForObject("SELECT COUNT(*) FROM audit_log WHERE action=? AND outcome=?",Long.class,action,outcome);}
 OidcUserRequest oidcRequest(String sub){
  var now=Instant.now();var id=new OidcIdToken("verified-token",now,now.plusSeconds(3600),Map.of("iss","https://issuer.invalid","aud",List.of("client"),"sub",sub));
  return new OidcUserRequest(clients.findByRegistrationId("google"),new OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER,"access",now,now.plusSeconds(3600)),id);
 }
 @Test void finalContextHasCommonBeansWithoutLabProfiles(){
  assertThat(context.getEnvironment().getActiveProfiles()).isEmpty();
  assertThat(context.getBeansOfType(PasswordLoginGate.class)).hasSize(1);
  assertThat(context.getBeansOfType(SessionRegistry.class)).hasSize(1);
  assertThat(context.getBeansOfType(JwtAuthenticationFilter.class)).isEmpty();
  assertThat(context.getBean(ShopMethodSecurityConfig.class)).isNotNull();
 }
 @Test void anonymousAndInsufficientPermissionsHaveJsonContract()throws Exception{
  mvc.perform(get("/api/orders/1001")).andExpect(status().isUnauthorized()).andExpect(jsonPath("code").value("UNAUTHENTICATED"));
  mvc.perform(get("/api/products/1")).andExpect(status().isOk());
  for(var request:List.of(get("/api/reports/sales"),delete("/api/orders/1001"),post("/api/orders/1001/refund").contentType("application/json").content("{\"reason\":\"test\"}")))
   mvc.perform(request.header("Authorization","Bearer "+token("alice"))).andExpect(status().isForbidden()).andExpect(jsonPath("code").value("FORBIDDEN"));
  mvc.perform(get("/api/reports/sales").header("Authorization","Bearer "+token("admin"))).andExpect(status().isOk());
 }
 @Test void methodSecurityAndAtomicRefundRemainActive()throws Exception{
  as("alice");assertThatThrownBy(()->orders.refund(1001,"refund")).isInstanceOf(org.springframework.security.access.AccessDeniedException.class);
  SecurityContextHolder.clearContext();
  mvc.perform(post("/api/orders/1001/refund").header("Authorization","Bearer "+token("cs")).contentType("application/json").content("{\"reason\":\"approved\"}")).andExpect(status().isNoContent());
  assertThat(jdbc.queryForObject("SELECT status FROM shop_order WHERE id=1001",String.class)).isEqualTo("REFUNDED");
  mvc.perform(post("/api/orders/1001/refund").header("Authorization","Bearer "+token("cs")).contentType("application/json").content("{\"reason\":\"again\"}")).andExpect(status().isConflict());
  assertThat(auditCount("ORDER_REFUND","SUCCESS")).isEqualTo(1);assertThat(auditCount("ORDER_REFUND","FAILURE")).isEqualTo(1);
 }
 @Test void jwtOwnershipUsesLocalUserId()throws Exception{
  mvc.perform(get("/api/orders/1001").header("Authorization","Bearer "+token("alice"))).andExpect(status().isOk());
  mvc.perform(get("/api/orders/1002").header("Authorization","Bearer "+token("alice"))).andExpect(status().isNotFound());
  mvc.perform(get("/api/orders/1002").header("Authorization","Bearer "+token("cs"))).andExpect(status().isOk());
 }
 @Test void localPasswordPolicyBlocksSocialAccounts(){
  var r=social.loginOrRegister("google","social-sub","social@example.com","Social");
  String username=jdbc.queryForObject("SELECT username FROM app_user WHERE id=?",String.class,r.userId());
  assertThatThrownBy(()->am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(username,"!external!"))).isInstanceOf(BadCredentialsException.class);
  jdbc.update("UPDATE app_user SET password_hash=? WHERE id=?",encoder.encode("known"),r.userId());
  assertThatThrownBy(()->am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated(username,"known"))).isInstanceOf(BadCredentialsException.class);
 }
 @Test void oidcRejectsLocalDisabledLockedExpiredAccounts(){
  social.link("google","linked-sub","a@example.com",1);
  for(String column:List.of("enabled","account_non_locked","account_non_expired")){
   jdbc.update("UPDATE app_user SET "+column+"=FALSE WHERE id=1");
   assertThatThrownBy(()->oidc.loadUser(oidcRequest("linked-sub"))).isInstanceOf(OAuth2AuthenticationException.class);
   jdbc.update("UPDATE app_user SET "+column+"=TRUE WHERE id=1");
  }
 }
 @Test void oidcIdentityIsLocalAndCanBeKickedWithPasswordSessions(){
  social.link("google","stable-external-sub","a@example.com",1);
  OidcUser u=oidc.loadUser(oidcRequest("stable-external-sub"));
  assertThat(u).isInstanceOf(LocalIdentity.class);assertThat(((LocalIdentity)u).userId()).isEqualTo(1L);
  assertThat(u.getName()).isEqualTo("alice");assertThat(u.getSubject()).isEqualTo("stable-external-sub");assertThat(u.getAttributes()).containsEntry("userId",1L);
  registry.registerNewSession("oidc",u);registry.registerNewSession("password",users.loadById(1L));
  assertThat(sessions.kick(1L)).isEqualTo(2);
  assertThat(registry.getSessionInformation("oidc").isExpired()).isTrue();
 }
 @Test void disablingAccountRevokesAccessRefreshAndOidcSession(){
  social.link("google","disable-sub","a@example.com",1);
  registry.registerNewSession("oidc",oidc.loadUser(oidcRequest("disable-sub")));
  String access=token("alice");var r=refresh.issueNew(1);
  sessions.disable(1L);
  assertThat(context.getBean(TokenVersionRevocation.class).isRevoked(jwt.verify(access).getPayload())).isTrue();
  assertThatThrownBy(()->refresh.rotate(r.rawToken())).hasMessage("REFRESH_REVOKED");
  assertThat(registry.getSessionInformation("oidc").isExpired()).isTrue();
 }
 @Test void expiringCredentialsUseTypedDatetime(){
  jdbc.update("UPDATE app_user SET credentials_expire_at=? WHERE id=1",LocalDateTime.now(ZoneOffset.UTC).plusHours(1));
  assertThat(am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated("alice","pw")).isAuthenticated()).isTrue();
  jdbc.update("UPDATE app_user SET credentials_expire_at=? WHERE id=1",LocalDateTime.now(ZoneOffset.UTC).minusHours(1));
  assertThatThrownBy(()->am.authenticate(UsernamePasswordAuthenticationToken.unauthenticated("alice","pw"))).isInstanceOf(CredentialsExpiredException.class);
 }
 @Test void jsonPasswordLoginPublishesFailuresAndLocksBeforeCorrectPassword()throws Exception{
  for(int i=0;i<5;i++)mvc.perform(post("/api/auth/login").with(req->{req.setRemoteAddr("127.0.0.12");return req;}).contentType("application/json").content("{\"username\":\"AlIcE\",\"password\":\"wrong\"}")).andExpect(status().isUnauthorized());
  assertThat(auditCount("LOGIN","FAILURE")).isEqualTo(5);
  mvc.perform(post("/api/auth/login").with(req->{req.setRemoteAddr("127.0.0.12");return req;}).header("X-Forwarded-For","198.51.100.123").contentType("application/json").content("{\"username\":\"alice\",\"password\":\"pw\"}")).andExpect(status().isTooManyRequests()).andExpect(header().exists("Retry-After"));
  assertThat(auditCount("LOGIN","FAILURE")).isEqualTo(5);
 }
 @Test void passwordAccountStatesAreEnforcedInBothLoginModes()throws Exception{
  int offset=30;
  for(String state:List.of("enabled","account_non_locked","account_non_expired","credentials_expire_at")){
   if(state.equals("credentials_expire_at"))jdbc.update("UPDATE app_user SET credentials_expire_at=? WHERE id=1",LocalDateTime.now(ZoneOffset.UTC).minusHours(1));
   else jdbc.update("UPDATE app_user SET "+state+"=FALSE WHERE id=1");
   String ip="127.0.0."+(offset++);
   for(String password:List.of("wrong","pw")){
    mvc.perform(post("/api/auth/login").with(r->{r.setRemoteAddr(ip);return r;}).contentType("application/json").content("{\"username\":\"alice\",\"password\":\""+password+"\"}")).andExpect(status().isUnauthorized());
    mvc.perform(post("/login").with(csrf()).with(r->{r.setRemoteAddr(ip);return r;}).param("username","alice").param("password",password)).andExpect(status().isUnauthorized());
   }
   if(state.equals("credentials_expire_at"))jdbc.update("UPDATE app_user SET credentials_expire_at=NULL WHERE id=1");
   else jdbc.update("UPDATE app_user SET "+state+"=TRUE WHERE id=1");
  }
 }
 @Test void formPasswordLoginLocksAndCsrfIsRetained()throws Exception{
  mvc.perform(post("/login").param("username","alice").param("password","pw")).andExpect(status().isForbidden());
  for(int i=0;i<5;i++)mvc.perform(post("/login").with(csrf()).with(req->{req.setRemoteAddr("127.0.0.13");return req;}).param("username","alice").param("password","wrong")).andExpect(status().isUnauthorized());
  assertThat(auditCount("LOGIN","FAILURE")).isEqualTo(5);
  mvc.perform(post("/login").with(csrf()).with(req->{req.setRemoteAddr("127.0.0.13");return req;}).param("username","alice").param("password","pw")).andExpect(status().isTooManyRequests());
 }
 @Test void jsonLoginAndRefreshActuallyIssueUsableTokens()throws Exception{
  String body=mvc.perform(post("/api/auth/login").contentType("application/json").content("{\"username\":\"alice\",\"password\":\"pw\"}")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
  assertThat(auditCount("LOGIN","SUCCESS")).isEqualTo(1);
  var json=new com.fasterxml.jackson.databind.ObjectMapper().readTree(body);String access=json.get("accessToken").asText(),rt=json.get("refreshToken").asText();
  mvc.perform(get("/api/orders/1001").header("Authorization","Bearer "+access)).andExpect(status().isOk());
  mvc.perform(post("/api/auth/refresh").contentType("application/json").content("{\"refreshToken\":\""+rt+"\"}")).andExpect(status().isOk()).andExpect(jsonPath("refreshToken").isNotEmpty());
 }
 @Test void concurrentRefreshAllowsOneRotationThenRevokesWholeFamily()throws Exception{
  var issued=refresh.issueNew(1);var start=new CountDownLatch(1);var pool=Executors.newFixedThreadPool(2);
  Callable<Object> rotate=()->{start.await();try{return refresh.rotate(issued.rawToken());}catch(IllegalStateException e){return e.getMessage();}};
  try{
   var a=pool.submit(rotate);var b=pool.submit(rotate);start.countDown();var results=List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS));
   assertThat(results.stream().filter(RefreshTokenService.Rotated.class::isInstance)).hasSize(1);
   assertThat(results).contains("REFRESH_REUSE_DETECTED");
   var success=(RefreshTokenService.Rotated)results.stream().filter(RefreshTokenService.Rotated.class::isInstance).findFirst().orElseThrow();
   assertThatThrownBy(()->refresh.rotate(success.next().rawToken())).hasMessage("REFRESH_REVOKED");
   assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM refresh_token WHERE family_id=? AND revoked_at IS NULL",Long.class,issued.familyId())).isZero();
  }finally{pool.shutdownNow();}
 }
 @Test void childInsertFailureRollsBackParentConsumption(){
  var issued=refresh.issueNew(1);
  jdbc.execute("CREATE TRIGGER fail_refresh_insert BEFORE INSERT ON refresh_token FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='verification failure'");
  try{assertThatThrownBy(()->refresh.rotate(issued.rawToken())).isInstanceOf(org.springframework.dao.DataAccessException.class);}
  finally{jdbc.execute("DROP TRIGGER fail_refresh_insert");}
  assertThat(refresh.rotate(issued.rawToken()).userId()).isEqualTo(1);
 }
 @Test void refreshExpiryIsIndependentOfJvmTimezone(){
  var old=TimeZone.getDefault();var now=Instant.parse("2030-01-01T00:00:00Z");
  try{
   for(String zone:List.of("Asia/Taipei","UTC","America/New_York")){
    TimeZone.setDefault(TimeZone.getTimeZone(zone));
    var service=new RefreshTokenService(jdbc,manager,Duration.ofHours(1),java.time.Clock.fixed(now,ZoneOffset.UTC));
    var issued=service.issueNew(1);assertThat(service.rotate(issued.rawToken()).userId()).isEqualTo(1);
    var later=new RefreshTokenService(jdbc,manager,Duration.ofHours(1),java.time.Clock.fixed(now.plusSeconds(3601),ZoneOffset.UTC));
    assertThatThrownBy(()->later.rotate(service.issueNew(1).rawToken())).hasMessage("REFRESH_EXPIRED");
   }
  }finally{TimeZone.setDefault(old);}
 }
 @Test void successfulAuditCommitsWithBusinessAndFailuresNeverLeaveSuccess(){
  long id=notes.seed("alice","old");notes.updateV2(id,"new",false);
  assertThat(notes.bodyOf(id)).isEqualTo("new");assertThat(auditCount("NOTE_UPDATE","SUCCESS")).isEqualTo(1);
  assertThatThrownBy(()->notes.updateV2(id,"should rollback",true)).isInstanceOf(IllegalStateException.class);
  assertThatThrownBy(()->notes.updateV2(id,"x".repeat(300),false)).isInstanceOf(org.springframework.dao.DataAccessException.class);
  assertThat(notes.bodyOf(id)).isEqualTo("new");assertThat(auditCount("NOTE_UPDATE","SUCCESS")).isEqualTo(1);assertThat(auditCount("NOTE_UPDATE","FAILURE")).isEqualTo(2);
 }
 @Test void auditOrchestratorRejectsAnExistingCallerTransaction(){
  long id=notes.seed("alice","old");
  new org.springframework.transaction.support.TransactionTemplate(manager).executeWithoutResult(status->{
   assertThatThrownBy(()->notes.updateV2(id,"new",false)).isInstanceOf(org.springframework.transaction.IllegalTransactionStateException.class);
  });
  assertThat(notes.bodyOf(id)).isEqualTo("old");assertThat(auditCount("NOTE_UPDATE","SUCCESS")).isZero();
 }
 @Test void corsHasExplicitOriginAndExposedHeader()throws Exception{
  mvc.perform(options("/api/orders/1001").header("Origin","https://app.example.com").header("Access-Control-Request-Method","GET").header("Access-Control-Request-Headers","Authorization"))
   .andExpect(status().isOk()).andExpect(header().string("Access-Control-Allow-Origin","https://app.example.com"));
  mvc.perform(options("/api/orders/1001").header("Origin","https://evil.invalid").header("Access-Control-Request-Method","GET")).andExpect(status().isForbidden());
  mvc.perform(get("/api/products/1").header("Origin","https://app.example.com")).andExpect(header().string("Access-Control-Expose-Headers","X-Total-Count"));
 }
 @Test void jwtRejectsDifferentAlgorithmTamperingExpiryAndDeletedUser()throws Exception{
  var key=Keys.hmacShaKeyFor("verification-only-random-fixture-0123456789-abcdefghijklmnopqrstuv".getBytes(java.nio.charset.StandardCharsets.UTF_8));
  String other=Jwts.builder().issuer("shop-service").subject("alice").signWith(key,Jwts.SIG.HS512).compact();
  assertThatThrownBy(()->jwt.verify(other)).isInstanceOf(JwtException.class);
  String expired=Jwts.builder().issuer("shop-service").subject("alice").claim("uid",1L).claim("ver",0).expiration(Date.from(Instant.now().minusSeconds(120))).signWith(key,Jwts.SIG.HS256).compact();
  mvc.perform(get("/api/orders/1001").header("Authorization","Bearer "+expired)).andExpect(status().isUnauthorized());
  String good=token("alice");String[] parts=good.split("\\.");String signature=(parts[2].charAt(0)=='A'?'B':'A')+parts[2].substring(1);
  mvc.perform(get("/api/orders/1001").header("Authorization","Bearer "+parts[0]+"."+parts[1]+"."+signature)).andExpect(status().isUnauthorized());
  var orphanRefresh=refresh.issueNew(1);
  jdbc.update("DELETE FROM user_role WHERE user_id=1");jdbc.update("DELETE FROM app_user WHERE id=1");
  mvc.perform(get("/api/orders/1001").header("Authorization","Bearer "+good)).andExpect(status().isUnauthorized());
  assertThatThrownBy(()->refresh.rotate(orphanRefresh.rawToken())).hasMessage("REFRESH_REVOKED");
 }
}
