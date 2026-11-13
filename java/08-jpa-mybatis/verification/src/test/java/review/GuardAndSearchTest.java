package review;

import com.example.lab.guard.*;
import com.example.lab.shop.*;
import com.example.lab.ch08.Dyn;
import com.example.lab.Uuid7;
import org.apache.ibatis.mapping.*;
import org.apache.ibatis.builder.StaticSqlSource;
import org.apache.ibatis.session.*;
import org.apache.ibatis.session.defaults.DefaultSqlSessionFactory;
import org.apache.ibatis.scripting.xmltags.XMLLanguageDriver;
import org.junit.jupiter.api.Test;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;
import static org.assertj.core.api.Assertions.*;
import static review.CriteriaCases.combinations;

class GuardAndSearchTest extends DatabaseFixture {
    SqlSessionFactory statement(String sql,SqlCommandType type){
        var cfg=new Configuration();
        var source=sql.startsWith("<script>")?new XMLLanguageDriver().createSqlSource(cfg,sql,Map.class):new StaticSqlSource(cfg,sql);
        cfg.addMappedStatement(new MappedStatement.Builder(cfg,"fixture.write",source,type).build());
        return new DefaultSqlSessionFactory(cfg);
    }
    @Test void readOnlyBoundaryRejectsWrites(){
        var cfg=new Configuration();cfg.addMappedStatement(new MappedStatement.Builder(cfg,"com.example.lab.shop.mybatis.Bad.write",new StaticSqlSource(cfg,"UPDATE orders SET status='PAID'"),SqlCommandType.UPDATE).build());
        assertThatThrownBy(()->new ReadOnlyBoundary(new DefaultSqlSessionFactory(cfg)).assertOnlySelect()).isInstanceOf(AssertionError.class);
        assertThatCode(()->new ReadOnlyBoundary(mybatis).assertOnlySelect()).doesNotThrowAnyException();
    }
    void version(SqlSessionFactory factory,List<Object> args){VersionWriteGuard.assertMaintained(factory,"fixture.",Set.of("orders"),Map.of("fixture.write",args));}
    @Test void versionGuardRequiresRealIncrementInsteadOfKeyword(){
        assertThatCode(()->version(statement("UPDATE orders SET status='PAID',version=version+1 WHERE id=?",SqlCommandType.UPDATE),List.of(Map.of()))).doesNotThrowAnyException();
        for(String sql:List.of("UPDATE orders SET status='PAID' WHERE id=?","UPDATE orders SET status='PAID' WHERE version=?","UPDATE orders SET status='version' WHERE id=?","UPDATE orders SET version=version WHERE id=?"))
            assertThatThrownBy(()->version(statement(sql,SqlCommandType.UPDATE),List.of(Map.of()))).as(sql).isInstanceOf(AssertionError.class);
    }
    @Test void versionGuardRejectsMissingExamplesAndBadDynamicBranches(){
        assertThatThrownBy(()->VersionWriteGuard.assertMaintained(mybatis,"intentionally.unmatched.",Set.of("orders"),Map.of())).isInstanceOf(AssertionError.class);
        var factory=statement("<script>UPDATE orders SET status='PAID'<if test='maintain'>,version=version+1</if> WHERE id=#{id}</script>",SqlCommandType.UPDATE);
        assertThatThrownBy(()->VersionWriteGuard.assertMaintained(factory,"fixture.",Set.of("orders"),Map.of())).isInstanceOf(AssertionError.class);
        assertThatThrownBy(()->version(factory,List.of(Dyn.args("maintain",true,"id",1),Dyn.args("maintain",false,"id",1)))).isInstanceOf(AssertionError.class);
        assertThatCode(()->version(factory,List.of(Dyn.args("maintain",true,"id",1)))).doesNotThrowAnyException();
    }
    @Test void paginationUsesTheRootKeyAndKnownToOneJoin(){
        String base="SELECT o.id FROM orders o JOIN customer c ON c.id=o.customer_id ";
        assertThatCode(()->OrderPageContract.assertUniqueOrderPage(base+"ORDER BY o.placed_at DESC,o.id DESC LIMIT 20")).doesNotThrowAnyException();
        for(String ending:List.of("ORDER BY c.id LIMIT 20","ORDER BY o.identity LIMIT 20","ORDER BY o.id+0 LIMIT 20","LIMIT 20"))
            assertThatThrownBy(()->OrderPageContract.assertUniqueOrderPage(base+ending)).as(ending).isInstanceOf(AssertionError.class);
        assertThatThrownBy(()->OrderPageContract.assertUniqueOrderPage(base+"LEFT JOIN order_item i ON i.order_id=o.id ORDER BY o.id LIMIT 20")).isInstanceOf(AssertionError.class);
        assertThatThrownBy(()->OrderPageContract.assertUniqueOrderPage("SELECT o.id FROM orders o JOIN customer c ON c.display_name=o.currency ORDER BY o.id LIMIT 20")).isInstanceOf(AssertionError.class);
    }

    String sql(String id,Object args){return mybatis.getConfiguration().getMappedStatement("com.example.lab.shop.mybatis.OrderSearchMapper."+id).getBoundSql(args).getSql();}

    @Test void deletedOrUnexpectedConditionFailsEvenWhenSqlStillParses(){
        String sql="SELECT o.id FROM orders o WHERE o.status=? AND o.placed_at>=?";
        var expected=Set.of("status","from");OptionalPredicateContract.assertPresent(sql,expected);
        assertThatThrownBy(()->OptionalPredicateContract.assertPresent(sql.replace(" AND o.placed_at>=?",""),expected)).isInstanceOf(AssertionError.class);
        assertThatThrownBy(()->OptionalPredicateContract.assertPresent(sql,Set.of("status"))).isInstanceOf(AssertionError.class);
        OptionalPredicateContract.assertPresent("SELECT o.id FROM orders o WHERE o.rep_id IS NOT NULL",Set.of("rep-present"));
        assertThatThrownBy(()->OptionalPredicateContract.assertPresent("SELECT o.id FROM orders o WHERE o.rep_id IS NULL",Set.of("rep-present"))).isInstanceOf(AssertionError.class);
    }

    @Test void emptyStatusesReturnNoRowsRatherThanAllRows(){
        place(1);
        assertThat(service.searchByStatuses(List.of(),0,20)).isEmpty();assertThat(service.searchByStatuses(null,0,20)).isEmpty();
        assertThat(service.searchByStatuses(List.of(OrderStatus.PENDING),0,20)).hasSize(1);
    }
    record Expected(UUID id,String no,OrderStatus status,BigDecimal amount,Instant at,String name){}
    List<Expected> seedSearch(){
        var out=new ArrayList<Expected>();
        UUID second=UUID.randomUUID();jdbc.update("INSERT INTO customer(id,email,display_name) VALUES(?,'other@example.test','plain')",Uuid7.toBytes(second));
        jdbc.update("UPDATE customer SET display_name='customer%_!' WHERE id=?",Uuid7.toBytes(customerId));
        for(int n=0;n<30;n++){
            UUID id=UUID.randomUUID();Instant at=Instant.parse("2026-09-01T00:00:00Z").plusSeconds(n*60L);
            var status=n%2==0?OrderStatus.PENDING:OrderStatus.PAID;var amount=BigDecimal.valueOf(100+n);
            String no="SEARCH-"+n;UUID customer=n%3==0?second:customerId;String name=customer.equals(second)?"plain":"customer%_!";
            jdbc.update("INSERT INTO orders(id,order_no,customer_id,status,total_amount,placed_at) VALUES(?,?,?,?,?,?)",Uuid7.toBytes(id),no,Uuid7.toBytes(customer),status.name(),amount,java.sql.Timestamp.from(at));
            out.add(new Expected(id,no,status,amount,at,name));
        }
        return out;
    }
    @Test void bothSearchImplementationsMatchAnIndependentOracleIncludingBoundaries(){
        var fixture=seedSearch();var cases=new ArrayList<>(combinations());
        cases.add(new OrderSearchCriteria(null,"%",null,null,null));
        cases.add(new OrderSearchCriteria(null,"_",null,null,null));
        cases.add(new OrderSearchCriteria(null,"!",null,null,null));
        cases.add(new OrderSearchCriteria(null,null,null,null,new BigDecimal("129")));
        for(var c:cases){
            var expected=fixture.stream().filter(r->c.status()==null||r.status()==c.status())
                .filter(r->c.customerKeyword()==null||r.name().contains(c.customerKeyword()))
                .filter(r->c.from()==null||!r.at().isBefore(c.from())).filter(r->c.to()==null||!r.at().isAfter(c.to()))
                .filter(r->c.minAmount()==null||r.amount().compareTo(c.minAmount())>=0)
                .sorted(Comparator.comparing(Expected::at).reversed()).map(Expected::no).toList();
            var jpa=service.searchPage(c,0,100);var mb=service.searchRows(c,0,100);
            assertThat(jpa.content().stream().map(OrderListRow::orderNo).toList()).as("JPA "+c).isEqualTo(expected);
            assertThat(mb.content().stream().map(OrderListRow::orderNo).toList()).as("MyBatis "+c).isEqualTo(expected);
            assertThat(jpa.total()).isEqualTo(expected.size());assertThat(mb.total()).isEqualTo(expected.size());
        }
    }
    @Test void tiedTimestampsArePaginatedWithoutDuplicatesOrMissingOrders(){
        var fixture=seedSearch();jdbc.update("UPDATE orders SET placed_at='2026-09-01 00:00:00'");
        List<UUID> jpa=new ArrayList<>(),mb=new ArrayList<>();
        for(int page=0;page<6;page++){
            jpa.addAll(service.searchPage(OrderSearchCriteria.empty(),page,5).content().stream().map(OrderListRow::id).toList());
            mb.addAll(service.searchRows(OrderSearchCriteria.empty(),page,5).content().stream().map(OrderListRow::id).toList());
        }
        assertThat(jpa).hasSize(30).doesNotHaveDuplicates().containsExactlyElementsOf(mb);
        assertThat(new HashSet<>(jpa)).isEqualTo(new HashSet<>(fixture.stream().map(Expected::id).toList()));
    }
    @Test void ambiguousEscapeAstCannotHideAnExtraPredicate(){
        assertThatThrownBy(()->OptionalPredicateContract.assertPresent(
            "SELECT o.id FROM orders o WHERE c.display_name LIKE ? ESCAPE '!' AND o.placed_at >= ?",Set.of("keyword")))
            .isInstanceOf(AssertionError.class);
        OptionalPredicateContract.assertPresent(
            "SELECT o.id FROM orders o WHERE (c.display_name LIKE ? ESCAPE '!') AND o.placed_at >= ?",Set.of("keyword","from"));
    }
    @Test void mainQueryFingerprintsAreCalibratedSeparatelyFromCountQueries(){
        seedSearch();var oldShapes=new HashSet<String>();var fixedShapes=new HashSet<String>();
        for(var c:combinations())for(boolean old:List.of(true,false)){
            com.example.lab.SqlSpy.start();
            try {
                tx.executeWithoutResult(st->{
                    var cb=em.getCriteriaBuilder();var cq=cb.createQuery(Order.class);var root=cq.from(Order.class);
                    cq.select(root).where((old?OldOrderSpecifications.of(c):OrderSpecifications.of(c)).toPredicate(root,cq,cb));
                    em.createQuery(cq).getResultList();
                });
            } finally {(old?oldShapes:fixedShapes).addAll(com.example.lab.SqlSpy.stop());}
        }
        assertThat(oldShapes).hasSize(16);assertThat(fixedShapes).hasSize(32);
        assertThat(oldShapes).hasSizeLessThanOrEqualTo(32);
        assertThatThrownBy(()->assertThat(oldShapes).hasSize(32)).isInstanceOf(AssertionError.class);
    }
}
