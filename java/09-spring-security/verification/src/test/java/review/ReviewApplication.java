package review;

import com.example.lab09.shop.*;
import com.example.lab09.ch08.*;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.*;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.client.registration.*;
import org.springframework.security.oauth2.core.AuthorizationGrantType;

@SpringBootConfiguration @EnableAutoConfiguration
@EntityScan(basePackageClasses=ShopOrder.class)
@EnableJpaRepositories(basePackageClasses=ShopOrderRepo.class)
@Import({ShopAuthConfig.class,ShopMethodSecurityConfig.class,ShopSessionConfig.class,ShopTokenConfig.class,
 ShopUserDetailsService.class,ShopSessionAdmin.class,ShopTokenController.class,ShopOidcConfig.class,
 ShopCorsConfig.class,ShopWebHardeningConfig.class,ShopAuditConfig.class,ShopOrderQueryService.class,
 ShopOrderService.class,ShopOrderChanges.class,ShopRefundController.class,TestEndpoints.class})
public class ReviewApplication {
 @Bean ClientRegistrationRepository clients(){return new InMemoryClientRegistrationRepository(
  ClientRegistration.withRegistrationId("google").clientId("client").clientSecret("secret")
   .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
   .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}").scope("openid")
   .authorizationUri("https://issuer.invalid/auth").tokenUri("https://issuer.invalid/token")
   .jwkSetUri("https://issuer.invalid/jwks").build());}
 @Bean NoteChanges noteChanges(JdbcTemplate jdbc,AuditLog audit){return new NoteChanges(jdbc,audit);}
 @Bean NoteService notes(JdbcTemplate jdbc,AuditLog audit,NoteChanges changes){return new NoteService(jdbc,audit,changes);}
}
