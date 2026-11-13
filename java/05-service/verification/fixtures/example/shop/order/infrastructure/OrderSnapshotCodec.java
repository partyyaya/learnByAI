package example.shop.order.infrastructure;
import example.shop.order.domain.*;
import java.util.List;
/** Only the PENDING_PAYMENT path is supplied; this is not the production snapshot codec. */
public class OrderSnapshotCodec {
    public Order copy(Order order) {
        if (order.status()!=OrderStatus.PENDING_PAYMENT || order.appliedCoupon()!=null)
            throw new UnsupportedOperationException("fixture codec only supports pending orders without coupon");
        var snapshot=order.shippingSnapshot();
        var address=new ShippingAddress(order.shippingAddressId(),order.customerId(),snapshot.recipientName(),
            snapshot.phone(),snapshot.postalCode(),snapshot.city(),snapshot.district(),snapshot.street());
        return Order.place(order.id(),order.orderNumber(),order.customerId(),order.idempotencyKey(),
            order.lines().stream().map(l->new PricedLine(l.productId(),l.productName(),l.sku(),l.unitPrice(),l.quantity())).toList(),
            address,null,(a,m)->order.shippingFee(),order.invoice(),order.customerNote(),order.createdAt());
    }
}
