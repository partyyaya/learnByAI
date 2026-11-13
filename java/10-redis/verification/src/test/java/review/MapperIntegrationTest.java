package review;
import com.example.lab10.shop.config.*;
import com.example.lab10.fixture.PrivateView;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.context.annotation.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.data.redis.serializer.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

@SpringBootTest(classes=MapperIntegrationTest.App.class,properties={"spring.data.redis.host=127.0.0.1","spring.data.redis.port=${review.redis.port:33420}","logging.level.root=ERROR"})
@AutoConfigureMockMvc
class MapperIntegrationTest {
 @SpringBootConfiguration @EnableAutoConfiguration(exclude={DataSourceAutoConfiguration.class,HibernateJpaAutoConfiguration.class})
 @Import({RedisConfig.class,CacheConfig.class,RedisHaConfig.class,MetricsConfig.class,Endpoints.class})
 static class App{}
 @RestController static class Endpoints {
  @GetMapping("/view") PrivateView view(){return new PrivateView();}
  @PostMapping("/view") String post(@RequestBody PrivateView view){return "ok";}
 }
 @Autowired MockMvc mvc;@Autowired ObjectMapper webMapper;@Autowired RedisConfig.RedisJson redisJson;
 @Autowired org.springframework.context.ApplicationContext context;
 @Autowired org.springframework.data.redis.core.StringRedisTemplate strings;
 @Autowired org.springframework.cache.CacheManager manager;
 @Autowired io.micrometer.core.instrument.MeterRegistry registry;
 @Test void redisMapperNeverReplacesWebMapper()throws Exception {
  var response=mvc.perform(get("/view")).andReturn().getResponse();
  assertThat(response.getStatus()).isEqualTo(200);
  assertThat(response.getContentAsString()).contains("displayName").doesNotContain("@class","password","fixture-private-password");
  assertThat(mvc.perform(post("/view").contentType("application/json").content("{\"displayName\":\"User\"}")).andReturn().getResponse().getStatus()).isEqualTo(200);
  assertThat(webMapper).isNotSameAs(redisJson.mapper());
 }
 @Test void cumulativeResourceCustomizersKeepOneResourcesBeanAndMetrics()throws Exception{
  assertThat(context.getBeansOfType(io.lettuce.core.resource.ClientResources.class)).hasSize(1);
  strings.opsForValue().set("metrics:probe","x");strings.opsForValue().get("metrics:probe");
  assertThat(registry.find("lettuce.command.completion").timers()).isNotEmpty();
  var resources=context.getBean(io.lettuce.core.resource.ClientResources.class);
  assertThat(resources.reconnectDelay().createDelay(1).toMillis()).isBetween(50L,1000L);
 }
 @Test void clearUsesScanWithoutKeys(){
  long keys=commandCalls("keys"),scan=commandCalls("scan");
  var cache=manager.getCache("products");cache.put("probe","value");cache.clear();
  assertThat(commandCalls("keys")).isEqualTo(keys);assertThat(commandCalls("scan")).isGreaterThan(scan);
 }
 long commandCalls(String name){
  try(var c=strings.getConnectionFactory().getConnection()){
   String stats=c.serverCommands().info("commandstats").getProperty("cmdstat_"+name);
   return stats==null?0:Long.parseLong(stats.substring("calls=".length(),stats.indexOf(',')));
  }
 }
 @Test void typedSerializerUsesPlainCopyAndKeepsGenericMapperUnchanged(){
  var configs=TypedCacheRecipe.configs(redisJson,org.springframework.data.redis.cache.RedisCacheConfiguration.defaultCacheConfig());
  var typed=configs.get("products").getValueSerializationPair();
  byte[] bytes=new byte[typed.write(new TypedCacheRecipe.Product(7)).remaining()];
  typed.write(new TypedCacheRecipe.Product(7)).get(bytes);
  assertThat(new String(bytes,java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("@class","com.example.lab10");
  assertThat(((TypedCacheRecipe.Product)typed.read(java.nio.ByteBuffer.wrap(bytes))).getId()).isEqualTo(7);
  assertThat(new String(new GenericJackson2JsonRedisSerializer(redisJson.mapper()).serialize(new PrivateView()),java.nio.charset.StandardCharsets.UTF_8)).contains("@class");
 }
}
