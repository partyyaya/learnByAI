package example.shop.verification;

import example.shop.common.money.Money;
import example.shop.common.web.IdempotencyKeyReusedException;
import example.shop.order.application.port.CreateOrderIntent;
import example.shop.order.application.port.IdempotencyStore;
import example.shop.order.domain.*;
import example.shop.order.domain.exception.*;
import example.shop.order.service.command.CreateOrderCommand;
import example.shop.order.testfixture.OrderTestBuilder;
import example.shop.order.infrastructure.InMemoryOrderRepository;
import example.shop.order.infrastructure.OrderSnapshotCodec;
import example.shop.verification.extracted.ExpirationAdapter;
import org.junit.jupiter.api.Test;
import java.math.BigDecimal;
import java.lang.reflect.Modifier;
import java.time.*;
import java.util.*;
import static example.shop.order.testfixture.OrderTestBuilder.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DomainRegressionTest {
    final Instant now = FIXED_NOW;

    @Test void tinyAmountNeverCreatesNegativeShares() {
        var parts = Money.twd("0.03").allocate(Collections.nCopies(6, BigDecimal.ONE));
        assertThat(parts.stream().map(Money::toPlainString)).containsExactly("0.01","0.01","0.01","0.00","0.00","0.00");
    }

    @Test void allocationPreservesTotalAndZeroWeightsAcrossCurrencyScales() {
        for (String currency : List.of("TWD","JPY","KWD")) {
            for (String total : List.of("0","0.001","0.03","1","100.123","123456789012345.67")) {
                Money amount = Money.of(total,currency);
                for (List<BigDecimal> weights : List.of(
                        List.of(BigDecimal.ZERO,BigDecimal.ONE,BigDecimal.TEN),
                        Collections.nCopies(7,new BigDecimal("0.0003")))) {
                    var parts = amount.allocate(weights);
                    assertThat(parts).hasSize(weights.size()).allMatch(m->!m.isNegative());
                    assertThat(parts.stream().reduce(Money.zero(amount.currency()),Money::plus)).isEqualTo(amount);
                    if (weights.getFirst().signum()==0) assertThat(parts.getFirst().isZero()).isTrue();
                }
            }
        }
    }

    @Test void allocationRejectsInvalidWeightsAndNegativeTotals() {
        for (List<BigDecimal> weights : List.of(List.<BigDecimal>of(),List.of(BigDecimal.ZERO),
                List.of(BigDecimal.ONE,new BigDecimal("-0.1")))) {
            assertThatThrownBy(()->Money.twd("1").allocate(weights)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(()->Money.twd("-1").allocate(List.of(BigDecimal.ONE))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void duplicateShipmentRowsCannotExceedOrderAndFailureDoesNotMutate() {
        var order = anOrder().withLines(aLine("p",3,"10")).paid().build();
        assertThatThrownBy(()->order.ship(List.of(new ShipmentLine("p",2),new ShipmentLine("p",2)),"t",Carrier.BLACK_CAT,now))
                .isInstanceOf(ShipmentQuantityExceededException.class);
        assertThat(order.status()).isEqualTo(OrderStatus.PAID);
        assertThat(order.shipments()).isEmpty();
    }

    @Test void duplicateOrderRowsMustAllBeShippedBeforeCompletion() {
        var order = anOrder().withLines(aLine("p",2,"10"),aLine("p",3,"10")).paid().build();
        order.ship(List.of(new ShipmentLine("p",3)),"first",Carrier.BLACK_CAT,now);
        assertThat(order.status()).isEqualTo(OrderStatus.PARTIALLY_SHIPPED);
        order.ship(List.of(new ShipmentLine("p",1),new ShipmentLine("p",1)),"second",Carrier.BLACK_CAT,now);
        assertThat(order.status()).isEqualTo(OrderStatus.SHIPPED);
    }

    @Test void anonymousCannotBypassCancellationGuard() {
        var order = anOrder().build();
        assertThat(order.canBeCancelledBy(Actor.ANONYMOUS,now)).isFalse();
        assertThatThrownBy(()->order.cancel(Actor.ANONYMOUS,CancelReason.CHANGED_MIND,null,now))
                .isInstanceOf(OrderNotCancellableException.class);
        assertThat(order.status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
    }

    @Test void timeoutReasonCannotCancelPaidOrNotYetExpiredOrders() {
        for (var order : List.of(anOrder().paid().build(),anOrder().build())) {
            assertThatThrownBy(()->order.cancel(Actor.SYSTEM,CancelReason.PAYMENT_TIMEOUT,null,now))
                    .isInstanceOf(OrderNotCancellableException.class);
            assertThat(order.cancellation()).isNull();
        }
    }

    @Test void expirationServiceRechecksFreshStateAndProducesNoSideEffectsOnSkip() {
        var orders = mock(ExpirationAdapter.Orders.class);
        var stock = mock(ExpirationAdapter.Stock.class);
        var events = mock(ExpirationAdapter.Events.class);
        var executor = new ExpirationAdapter(orders,stock,events);
        for (var order : List.of(anOrder().paid().build(),anOrder().build())) {
            when(orders.findById(order.id())).thenReturn(Optional.of(order));
            assertThat(executor.cancelInNewTransaction(order.id(),now)).isFalse();
        }
        verify(orders,never()).save(any());
        verifyNoInteractions(stock,events);
    }

    @Test void expirationServiceCancelsAnActuallyExpiredPendingOrder() {
        var orders = mock(ExpirationAdapter.Orders.class);
        var stock = mock(ExpirationAdapter.Stock.class);
        var events = mock(ExpirationAdapter.Events.class);
        var order = anOrder().expired().build();
        when(orders.findById(order.id())).thenReturn(Optional.of(order));
        assertThat(new ExpirationAdapter(orders,stock,events).cancelInNewTransaction(order.id(),now)).isTrue();
        assertThat(order.status()).isEqualTo(OrderStatus.CANCELLED);
        verify(orders).save(order);verify(stock).release("P-1",2);verify(events).publish(any());
    }

    @Test void negativeOrZeroRefundCannotExpandAvailableAmount() {
        for (String amount : List.of("-50","0")) {
            assertThatThrownBy(()->new Refund("r",Money.twd(amount),RefundReason.GOODWILL,Actor.SYSTEM,now))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        var payment = Payment.succeeded("p",Money.twd("100"),PaymentMethod.CREDIT_CARD,now);
        payment.refund(new Refund("r1",Money.twd("50"),RefundReason.GOODWILL,Actor.SYSTEM,now));
        payment.refund(new Refund("r2",Money.twd("50"),RefundReason.GOODWILL,Actor.SYSTEM,now));
        assertThatThrownBy(()->payment.refund(new Refund("r3",Money.twd("0.01"),RefundReason.GOODWILL,Actor.SYSTEM,now)))
                .isInstanceOf(RefundExceedsPaymentException.class);
        assertThat(payment.refundedAmount()).isEqualTo(Money.twd("100"));
    }

    @Test void builderUsesBusinessFactsAndKeepsTransitionPrivate() throws Exception {
        for (var status : List.of(OrderStatus.PENDING_PAYMENT,OrderStatus.PAID,
                OrderStatus.PARTIALLY_SHIPPED,OrderStatus.SHIPPED,OrderStatus.DELIVERED,OrderStatus.CANCELLED)) {
            var order = anOrder().status(status).build();
            assertThat(order.status()).isEqualTo(status);
            if (status.isPaid()) assertThat(order.payments()).hasSize(1);
            if (status==OrderStatus.SHIPPED || status==OrderStatus.DELIVERED) assertThat(order.shipments()).hasSize(1);
        }
        var paid = anOrder().paid().build();
        assertThatCode(()->paid.ship(List.of(new ShipmentLine("P-1",2)),"t",Carrier.BLACK_CAT,now)).doesNotThrowAnyException();
        assertThat(Modifier.isPrivate(Order.class.getDeclaredMethod("transitionTo",OrderStatus.class).getModifiers())).isTrue();
        assertThat(anOrder().delivered().deliveredAt(now.minus(Duration.ofDays(7))).build().deliveredAt())
                .isEqualTo(now.minus(Duration.ofDays(7)));
    }

    @Test void fakeDoesNotPersistUnsavedChangesInEitherDirection() {
        var repository = new InMemoryOrderRepository(new OrderSnapshotCodec());
        var original = anOrder().build();repository.save(original);
        original.cancel(Actor.SYSTEM,CancelReason.CHANGED_MIND,null,now);
        assertThat(repository.findById(original.id()).orElseThrow().status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        var loaded = repository.findById(original.id()).orElseThrow();
        loaded.cancel(Actor.SYSTEM,CancelReason.CHANGED_MIND,null,now);
        assertThat(repository.findById(original.id()).orElseThrow().status()).isEqualTo(OrderStatus.PENDING_PAYMENT);
    }

    @Test void insufficientStockPreventsOrderAndOutboxPersistence() {
        var stock=mock(example.shop.verification.extracted.StockReservationAdapter.StockPort.class);
        var persist=mock(Runnable.class);
        when(stock.tryReserve("P-1",2)).thenReturn(false);
        var adapter=new example.shop.verification.extracted.StockReservationAdapter(stock,persist);
        assertThatThrownBy(()->adapter.create(anOrder().build())).isInstanceOf(InsufficientStockException.class);
        verifyNoInteractions(persist);
    }

    CreateOrderCommand command(List<CreateOrderCommand.Line> lines,String address,String coupon,String note,CreateOrderCommand.InvoiceSpec invoice) {
        return new CreateOrderCommand(new Actor(Actor.ActorType.CUSTOMER,"C-1","customer"),"key",lines,address,coupon,note,invoice);
    }
    @Test void sameKeyRequiresAllIntentFieldsToMatch() {
        var lines = List.of(new CreateOrderCommand.Line("p",2));
        var original = command(lines,"a",null,null,null);
        var entry = new IdempotencyStore.Entry(CreateOrderIntent.from(original),"O-existing");
        assertThatCode(()->entry.requireSameIntent("key",CreateOrderIntent.from(command(lines,"a",null,null,null)))).doesNotThrowAnyException();
        for (var changed : List.of(
                command(List.of(new CreateOrderCommand.Line("q",2)),"a",null,null,null),
                command(List.of(new CreateOrderCommand.Line("p",3)),"a",null,null,null),
                command(lines,"b",null,null,null),command(lines,"a","coupon",null,null),
                command(lines,"a",null,"note",null),command(lines,"a",null,null,
                        new CreateOrderCommand.InvoiceSpec(InvoiceType.COMPANY,"12345678","company",null,null)))) {
            assertThatThrownBy(()->entry.requireSameIntent("key",CreateOrderIntent.from(changed)))
                    .isInstanceOf(IdempotencyKeyReusedException.class);
        }
    }
}
