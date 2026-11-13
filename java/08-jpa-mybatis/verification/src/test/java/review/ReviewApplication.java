package review;
import com.example.lab.shop.*;
import com.example.lab.SqlSpy;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.domain.EntityScan;
import org.springframework.context.annotation.*;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.mybatis.spring.annotation.MapperScan;
@Configuration(proxyBeanMethods=false)
@EnableAutoConfiguration
@EntityScan(basePackages={"com.example.lab.shop","review.model"})
@EnableJpaRepositories("com.example.lab.shop")
@MapperScan(basePackages={"com.example.lab.shop.mybatis","com.example.lab.ch07","review.mapper"},annotationClass=org.apache.ibatis.annotations.Mapper.class)
@Import({OrderService.class,StockService.class,OrderSearchQuery.class,OrderImportService.class,com.example.lab.ch07.KeyBatchService.class,SqlSpy.class})
public class ReviewApplication {
    @Bean com.github.pagehelper.PageInterceptor pageInterceptor(){
        var plugin=new com.github.pagehelper.PageInterceptor();var options=new java.util.Properties();
        options.setProperty("helperDialect","mysql");plugin.setProperties(options);return plugin;
    }
}
