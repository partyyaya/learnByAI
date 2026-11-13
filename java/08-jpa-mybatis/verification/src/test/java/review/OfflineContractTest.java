package review;
import com.example.lab.shop.*;
import com.example.lab.ch08.Dyn;
import com.example.lab.guard.*;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.session.*;
import org.apache.ibatis.session.defaults.DefaultSqlSessionFactory;
import org.junit.jupiter.api.Test;
import java.util.*;import java.time.Instant;
import static org.assertj.core.api.Assertions.*;
import static review.CriteriaCases.combinations;

/** No Spring context, JDBC Environment or DataSource. */
class OfflineContractTest {
    static SqlSessionFactory factory(String replacement){
        Configuration cfg=new Configuration();
        cfg.getTypeHandlerRegistry().register(new com.example.lab.mybatis.UuidTypeHandler());
        for(String resource:List.of("OrderQueryMapper.xml","OrderSearchMapper.xml")){
            try(var in=OfflineContractTest.class.getClassLoader().getResourceAsStream(resource)){
                if(in==null)throw new IllegalStateException(resource);
                byte[] bytes=in.readAllBytes();
                if(resource.equals("OrderSearchMapper.xml")&&replacement!=null)
                    bytes=new String(bytes,java.nio.charset.StandardCharsets.UTF_8).replace(
                        "<if test=\"q.from != null\">            AND o.placed_at &gt;= #{q.from}                   </if>",replacement)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                new XMLMapperBuilder(new java.io.ByteArrayInputStream(bytes),cfg,resource,cfg.getSqlFragments()).parse();
            }catch(java.io.IOException e){throw new java.io.UncheckedIOException(e);}
        }
        return new DefaultSqlSessionFactory(cfg);
    }
    final SqlSessionFactory mybatis=factory(null);
    String sql(String id,Object args){return mybatis.getConfiguration().getMappedStatement("com.example.lab.shop.mybatis.OrderSearchMapper."+id).getBoundSql(args).getSql();}
    @Test void allThirtyTwoSearchCombinationsContainExactlyTheirPredicates(){
        for(var c:combinations())for(String id:List.of("search","searchCount")){
            var expected=OptionalPredicateContract.expected(c.status()!=null,c.customerKeyword()!=null,c.from()!=null,c.to()!=null,c.minAmount()!=null,null);
            OptionalPredicateContract.assertPresent(sql(id,Dyn.args("q",c,"offset",0,"size",20)),expected);
        }
    }
    @Test void everyProductionPageSqlPassesTheAstContract(){
        OrderPageContract.assertUniqueOrderPage(sql("search",Dyn.args("q",OrderSearchCriteria.empty(),"offset",0,"size",20)));
        OrderPageContract.assertUniqueOrderPage(sql("searchByStatuses",Dyn.args("statuses",List.of(OrderStatus.PENDING),"offset",0,"size",20)));
        OrderPageContract.assertUniqueOrderPage(sql("pageAfter",Dyn.args("status",OrderStatus.PENDING,"lastPlacedAt",Instant.parse("2026-09-01T00:00:00Z"),"lastId",UUID.randomUUID(),"size",20)));
    }
    @Test void actualRemovedXmlConditionFailsThePresenceContract(){
        var changed=factory("");
        var c=new OrderSearchCriteria(null,null,Instant.parse("2026-09-01T00:00:00Z"),null,null);
        String sql=changed.getConfiguration().getMappedStatement("com.example.lab.shop.mybatis.OrderSearchMapper.search")
            .getBoundSql(Dyn.args("q",c,"offset",0,"size",20)).getSql();
        assertThat(sql).doesNotContain("o.placed_at >=");
        assertThatThrownBy(()->OptionalPredicateContract.assertPresent(sql,Set.of("from"))).isInstanceOf(AssertionError.class);
    }
    @Test void emptyCollectionIsAnExplicitRejectPredicateOffline()throws Exception{
        String sql=sql("searchByStatuses",Dyn.args("statuses",List.of(),"offset",0,"size",20));
        var p=(net.sf.jsqlparser.statement.select.PlainSelect)((net.sf.jsqlparser.statement.select.Select)
            net.sf.jsqlparser.parser.CCJSqlParserUtil.parse(sql)).getSelectBody();
        assertThat(p.getWhere().toString().replaceAll("\\s+","")).isEqualTo("1=0");
    }
}
