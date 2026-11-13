package review;

import com.example.lab.SqlSpy;
import com.example.lab.ch07.*;
import com.example.lab.shop.OrderImportService;
import org.hibernate.SessionFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import java.math.BigDecimal;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

class MappingAndBatchTest extends DatabaseFixture {
    @Autowired KeyBatchService writer;
    @Autowired KeyMapper keys;
    @Autowired OrderImportService importer;
    List<SeqRow> rows(int n){var rows=new ArrayList<SeqRow>();for(int i=0;i<n;i++)rows.add(new SeqRow("r"+i,BigDecimal.ONE));return rows;}
    @Test void batchTailInsertsExactlyTheInputRows(){
        writer.insertRows(rows(53),50);assertThat(keys.countSeq()).isEqualTo(53);
        var input=rows(3);assertThat(keys.insertMany(input)).isEqualTo(3);
        assertThat(keys.countSeq()).isEqualTo(56); // no padding of VALUES
    }
    @Test void failureAfterAnEarlierFlushRollsBackAllChunks(){
        var rows=new ArrayList<>(rows(3));rows.add(new SeqRow("x".repeat(60),BigDecimal.ONE));
        assertThatThrownBy(()->writer.insertRows(rows,2)).isInstanceOf(RuntimeException.class);
        assertThat(keys.countSeq()).isZero();
    }
    @Test void requiredBatchJoinsTheOuterSpringTransaction(){
        assertThatThrownBy(()->tx.executeWithoutResult(s->{writer.insertRows(rows(3),2);throw new IllegalStateException("rollback outer");})).isInstanceOf(IllegalStateException.class);
        assertThat(keys.countSeq()).isZero();
    }
    @Test void requiresNewIsExplicitlyIndependentOfOuterRollback(){
        assertThatThrownBy(()->tx.executeWithoutResult(s->{writer.insertRowsInNewTransaction(rows(3),2);throw new IllegalStateException("rollback outer");})).isInstanceOf(IllegalStateException.class);
        assertThat(keys.countSeq()).isEqualTo(3);
    }
    @Test void existingSimpleSessionCannotSilentlySwitchExecutorType(){
        assertThatThrownBy(()->tx.executeWithoutResult(s->{keys.countSeq();writer.insertRows(rows(1),1);})).isInstanceOf(RuntimeException.class);
        assertThat(keys.countSeq()).isZero();
    }
    @Test void batchSizeMustBePositive(){
        assertThatThrownBy(()->writer.insertRows(rows(1),0)).isInstanceOf(IllegalArgumentException.class);
        assertThat(keys.countSeq()).isZero();
    }
    @Test void existingDecimalColumnsDecidePrecisionRatherThanAnnotationScale(){
        tx.executeWithoutResult(s->em.persist(new review.model.MoneyProbe(1,new BigDecimal("100.1234"),"ok")));
        var row=jdbc.queryForMap("SELECT bare,annotated FROM money_probe");
        assertThat((BigDecimal)row.get("bare")).isEqualByComparingTo("100.1234");
        assertThat((BigDecimal)row.get("annotated")).isEqualByComparingTo("100.1234");
        tx.executeWithoutResult(s->em.persist(new review.model.MoneyProbe(2,new BigDecimal("100.12345"),"ok")));
        assertThat(jdbc.queryForObject("SELECT bare FROM money_probe WHERE id=2",BigDecimal.class)).isEqualByComparingTo("100.1235");
    }
    @Test void numericEqualityDoesNotTriggerAnUpdateForOnlyScaleChange(){
        tx.executeWithoutResult(s->em.persist(new review.model.MoneyProbe(1,new BigDecimal("100"),"ok")));
        var stats=emf.unwrap(SessionFactory.class).getStatistics();stats.clear();SqlSpy.start();
        try {
            tx.executeWithoutResult(s->{var m=em.find(review.model.MoneyProbe.class,1L);assertThat(m.bare.scale()).isEqualTo(4);m.bare=new BigDecimal("100");});
            assertThat(stats.getEntityUpdateCount()).isZero();
        } finally {assertThat(SqlSpy.stop()).noneMatch(x->x.toLowerCase().startsWith("update"));}
    }
    @Test void nullableFalseHasRuntimeEffectWithTheMinimalPom(){
        SqlSpy.start();Throwable error;
        try{error=catchThrowable(()->tx.executeWithoutResult(s->em.persist(new review.model.MoneyProbe(1,BigDecimal.ONE,null))));}
        finally{assertThat(SqlSpy.stop()).noneMatch(x->x.toLowerCase().startsWith("insert"));}
        assertThat(error).isNotNull();while(error.getCause()!=null)error=error.getCause();
        assertThat(error).isInstanceOf(org.hibernate.PropertyValueException.class);
        jdbc.update("INSERT INTO money_probe(id,bare,annotated,required) VALUES(2,1,1,NULL)"); // DB allows null; rejection was Hibernate's.
    }
    @Test void courseImportActuallyBatchesAndProducesAllRows(){
        jdbc.update("UPDATE stock SET qty=100");
        var input=new ArrayList<OrderImportService.Row>();
        for(int i=0;i<100;i++)input.add(new OrderImportService.Row(UUID.randomUUID(),"IMP-"+i,customerId,productId,1,UUID.randomUUID()));
        SqlSpy.start();int imported;
        try{imported=importer.importOrders(input);}finally{
            var sql=SqlSpy.stop();assertThat(sql).anyMatch(x->x.contains("[batch ×"));assertThat(sql.size()).isLessThanOrEqualTo(12);
        }
        assertThat(imported).isEqualTo(100);assertThat(count("orders")).isEqualTo(100);assertThat(count("order_item")).isEqualTo(100);
        assertThat(stock(productId,"reserved_qty")).isEqualTo(100);assertThat(stock(productId,"qty")).isEqualTo(100);
    }
    @Test void importInventoryFailureRollsBackAllInsertedOrders(){
        var input=new ArrayList<OrderImportService.Row>();
        for(int i=0;i<11;i++)input.add(new OrderImportService.Row(UUID.randomUUID(),"FAIL-"+i,customerId,productId,1,UUID.randomUUID()));
        assertThatThrownBy(()->importer.importOrders(input)).isInstanceOf(com.example.lab.shop.InsufficientStockException.class);
        assertThat(count("orders")).isZero();assertThat(count("order_item")).isZero();assertThat(stock(productId,"reserved_qty")).isZero();
    }
}
