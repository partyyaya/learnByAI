package review;

import com.example.lab09.shop.ShopTokenConfig;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.context.annotation.*;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

class SecretContractTest {
 @Configuration @Import(ShopTokenConfig.class) static class Config {
  @Bean static PropertySourcesPlaceholderConfigurer placeholders(){return new PropertySourcesPlaceholderConfigurer();}
  @Bean JdbcTemplate jdbc(){return mock(JdbcTemplate.class);}
  @Bean PlatformTransactionManager manager(){return mock(PlatformTransactionManager.class);}
 }
 @Test void missingBlankAndWeakSecretsFailStartup(){
  for(String secret:new String[]{"${UNSET_SECURITY_VERIFICATION_SECRET_09}","","short"})
   new ApplicationContextRunner().withInitializer(c->c.getBeanFactory().setConversionService(ApplicationConversionService.getSharedInstance()))
    .withUserConfiguration(Config.class).withPropertyValues("shop.jwt.secret="+secret,"shop.jwt.refresh-ttl=14d")
    .run(c->assertThat(c).hasFailed());
 }
}
