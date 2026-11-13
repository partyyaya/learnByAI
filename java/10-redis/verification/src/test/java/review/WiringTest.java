package review;
import com.example.lab10.shop.config.RedisHaConfig;
import io.lettuce.core.resource.ClientResources;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration;
import org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration;
import org.springframework.boot.actuate.autoconfigure.metrics.MetricsAutoConfiguration;
import org.springframework.boot.actuate.autoconfigure.metrics.export.simple.SimpleMetricsExportAutoConfiguration;
import org.springframework.boot.actuate.autoconfigure.metrics.redis.LettuceMetricsAutoConfiguration;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.*;
import org.springframework.cache.CacheManager;
import org.springframework.cache.concurrent.ConcurrentMapCacheManager;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.*;

class WiringTest {
 @Configuration @EnableCaching static class EnableCacheOnly{}
 ApplicationContextRunner baseline(){return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(RedisAutoConfiguration.class,CacheAutoConfiguration.class)).withUserConfiguration(EnableCacheOnly.class).withPropertyValues("spring.data.redis.host=127.0.0.1","spring.data.redis.port="+Integer.getInteger("review.redis.port",33420));}
 @Test void redisStarterSelectsRedisCacheManager(){baseline().run(c->assertThat(c.getBean(CacheManager.class)).isInstanceOf(RedisCacheManager.class));}
 @Test void simpleProviderMustBeSelectedExplicitly(){baseline().withPropertyValues("spring.cache.type=simple").run(c->assertThat(c.getBean(CacheManager.class)).isInstanceOf(ConcurrentMapCacheManager.class));}
 @Test void bootMetricsRemainEnabledWithOnlyReconnectCustomizer(){
  new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(RedisAutoConfiguration.class,MetricsAutoConfiguration.class,SimpleMetricsExportAutoConfiguration.class,LettuceMetricsAutoConfiguration.class))
   .withUserConfiguration(RedisHaConfig.class)
   .withPropertyValues("spring.data.redis.host=127.0.0.1","spring.data.redis.port="+Integer.getInteger("review.redis.port",33420))
   .run(c->{
    assertThat(c).hasNotFailed();assertThat(c.getBeansOfType(ClientResources.class)).hasSize(1);
    var redis=c.getBean(StringRedisTemplate.class);redis.opsForValue().set("metric:default","1");redis.opsForValue().get("metric:default");
    assertThat(c.getBean(MeterRegistry.class).find("lettuce.command.completion").timers()).isNotEmpty();
   });
 }
}
