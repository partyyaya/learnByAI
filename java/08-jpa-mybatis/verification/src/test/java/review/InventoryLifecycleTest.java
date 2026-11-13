package review;

import com.example.lab.shop.*;
import com.example.lab.Uuid7;
import org.junit.jupiter.api.Test;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;

class InventoryLifecycleTest extends DatabaseFixture {
    @Test void reserveUsesAvailableInsteadOfTotalAndReturnsBusinessFailure() {
        jdbc.update("UPDATE stock SET reserved_qty=8");
        assertThatThrownBy(()->stocks.reserve(productId,3)).isInstanceOf(InsufficientStockException.class);
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stock(productId,"reserved_qty")).isEqualTo(8);
        stocks.reserve(productId,2);
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stock(productId,"reserved_qty")).isEqualTo(10);
        assertThat(stocks.available(productId)).isZero();
    }
    @Test void domainAndAtomicPathsUseTheSameTotalModel() {
        tx.executeWithoutResult(s->em.find(Stock.class,productId).reserve(3));
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stock(productId,"reserved_qty")).isEqualTo(3);
        tx.executeWithoutResult(s->em.find(Stock.class,productId).release(2));
        assertThat(stock(productId,"reserved_qty")).isEqualTo(1);
        stocks.reserveAndReturn(productId,2);
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stocks.available(productId)).isEqualTo(7);
    }
    @Test void schemaActuallyRejectsReservedGreaterThanTotal() {
        assertThatThrownBy(()->jdbc.update("UPDATE stock SET reserved_qty=11")).isInstanceOf(org.springframework.dao.DataAccessException.class);
        assertThat(stock(productId,"reserved_qty")).isZero();
    }
    @Test void placeAndAddItemReserveExactlyTheRequestedQuantity() {
        UUID oid=place(1);service.addItem(oid,productId,2,UUID.randomUUID());
        assertThat(count("order_item")).isEqualTo(2);assertThat(total(oid)).isEqualByComparingTo("300");
        assertThat(stock(productId,"reserved_qty")).isEqualTo(3);assertThat(stock(productId,"qty")).isEqualTo(10);
    }
    @Test void insufficientAddedItemRollsBackOrderItemAmountAndVersion() {
        UUID oid=place(1);
        long before=jdbc.queryForObject("SELECT version FROM orders",Long.class);
        assertThatThrownBy(()->service.addItem(oid,productId,99,UUID.randomUUID())).isInstanceOf(InsufficientStockException.class);
        assertThat(count("order_item")).isEqualTo(1);assertThat(total(oid)).isEqualByComparingTo("100");
        assertThat(jdbc.queryForObject("SELECT version FROM orders",Long.class)).isEqualTo(before);
        assertThat(stock(productId,"reserved_qty")).isEqualTo(1);
    }
    @Test void removeItemReleasesOnlyThatItemsReservation() {
        UUID oid=place(1),second=UUID.randomUUID();service.addItem(oid,productId,2,second);
        service.removeItem(oid,second);
        assertThat(count("order_item")).isEqualTo(1);assertThat(total(oid)).isEqualByComparingTo("100");
        assertThat(stock(productId,"reserved_qty")).isEqualTo(1);
    }
    @Test void missingOrForeignItemDoesNotReleaseInventory() {
        UUID one=place(1),two=place(1),foreign=firstItem(two);
        assertThatThrownBy(()->service.removeItem(one,foreign)).isInstanceOf(IllegalArgumentException.class);
        assertThat(count("order_item")).isEqualTo(2);assertThat(stock(productId,"reserved_qty")).isEqualTo(2);
    }
    @Test void cancelReleasesAllProductsOnceAndLeavesTotalsUnchanged() {
        UUID second=UUID.randomUUID();product(second,"TWO",4);
        UUID oid=place(2);service.addItem(oid,second,3,UUID.randomUUID());
        service.cancel(oid);service.cancel(oid);
        assertThat(status(oid)).isEqualTo("CANCELLED");
        assertThat(stock(productId,"reserved_qty")).isZero();assertThat(stock(second,"reserved_qty")).isZero();
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stock(second,"qty")).isEqualTo(4);
    }
    @Test void failedReleaseRollsBackTheCancellationState() {
        UUID oid=place(2);jdbc.update("UPDATE stock SET reserved_qty=0");
        assertThatThrownBy(()->service.cancel(oid)).isInstanceOf(IllegalStateException.class);
        assertThat(status(oid)).isEqualTo("PENDING");
    }
    @Test void failureOnSecondReleaseAlsoRollsBackTheFirstRelease() {
        UUID second=UUID.randomUUID();product(second,"SECOND",5);
        UUID oid=place(1);service.addItem(oid,second,2,UUID.randomUUID());
        // Domain service releases UUIDs in sorted order. Corrupt the later one only.
        UUID first=productId.compareTo(second)<0?productId:second;
        UUID last=first.equals(productId)?second:productId;
        int before=stock(first,"reserved_qty");
        jdbc.update("UPDATE stock SET reserved_qty=0 WHERE product_id=?",Uuid7.toBytes(last));
        assertThatThrownBy(()->service.cancel(oid)).isInstanceOf(IllegalStateException.class);
        assertThat(stock(first,"reserved_qty")).isEqualTo(before);assertThat(status(oid)).isEqualTo("PENDING");
    }
    @Test void paidOrderCannotBeCancelledOrChangeDiscount() {
        UUID oid=place(2);service.pay(oid);
        assertThatThrownBy(()->service.cancel(oid)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(()->tx.executeWithoutResult(s->em.find(Order.class,oid).applyDiscount(BigDecimal.ONE))).isInstanceOf(IllegalStateException.class);
        assertThat(status(oid)).isEqualTo("PAID");assertThat(stock(productId,"reserved_qty")).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT discount_amount FROM orders",BigDecimal.class)).isEqualByComparingTo("0");
    }
    @Test void removalCannotMakeDiscountExceedRemainingTotal() {
        UUID oid=place(1);UUID item=firstItem(oid);
        tx.executeWithoutResult(s->em.find(Order.class,oid).applyDiscount(new BigDecimal("90")));
        assertThatThrownBy(()->service.removeItem(oid,item)).isInstanceOf(IllegalStateException.class);
        assertThat(total(oid)).isEqualByComparingTo("100");assertThat(count("order_item")).isEqualTo(1);
        assertThat(stock(productId,"reserved_qty")).isEqualTo(1);
        tx.executeWithoutResult(s->em.find(Order.class,oid).applyDiscount(BigDecimal.ZERO));
        service.removeItem(oid,item);assertThat(total(oid)).isEqualByComparingTo("0");assertThat(stock(productId,"reserved_qty")).isZero();
    }
    @Test void concurrentReservationsCannotExceedAvailableQuantity()throws Exception {
        jdbc.update("UPDATE stock SET reserved_qty=8");
        try(var pool=Executors.newFixedThreadPool(8)){
            List<Future<Boolean>> jobs=new ArrayList<>();
            for(int i=0;i<20;i++)jobs.add(pool.submit(()->{try{stocks.reserve(productId,1);return true;}catch(InsufficientStockException e){return false;}}));
            int wins=0;for(var job:jobs)if(job.get(30,TimeUnit.SECONDS))wins++;
            assertThat(wins).isEqualTo(2);
        }
        assertThat(stock(productId,"qty")).isEqualTo(10);assertThat(stock(productId,"reserved_qty")).isEqualTo(10);
    }
    @Test void concurrentCancellationCannotReleaseTwice()throws Exception {
        UUID oid=place(3);var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)){
            List<Future<?>> jobs=new ArrayList<>();
            for(int i=0;i<2;i++)jobs.add(pool.submit(()->{try{start.await();service.cancel(oid);}catch(ObjectOptimisticLockingFailureException expected){}catch(InterruptedException e){throw new RuntimeException(e);}}));
            start.countDown();for(var job:jobs)job.get(30,TimeUnit.SECONDS);
        }
        assertThat(status(oid)).isEqualTo("CANCELLED");assertThat(stock(productId,"reserved_qty")).isZero();
    }
}
