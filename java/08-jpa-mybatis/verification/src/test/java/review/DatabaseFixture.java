package review;

import com.example.lab.shop.*;
import com.example.lab.Uuid7;
import jakarta.persistence.*;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import java.math.BigDecimal;
import java.util.*;

@SpringBootTest(classes=ReviewApplication.class)
abstract class DatabaseFixture {
    @Autowired OrderService service;
    @Autowired StockService stocks;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired EntityManager em;
    @Autowired EntityManagerFactory emf;
    @Autowired org.apache.ibatis.session.SqlSessionFactory mybatis;
    UUID customerId,productId;
    @BeforeEach void seed() {
        for(String table:List.of("order_item","orders","stock","product","customer","money_probe","seq_row"))
            jdbc.update("DELETE FROM "+table);
        customerId=UUID.randomUUID();productId=UUID.randomUUID();
        jdbc.update("INSERT INTO customer(id,email,display_name) VALUES(?,'fixture@example.test','customer')",Uuid7.toBytes(customerId));
        product(productId,"ONE",10);
    }
    void product(UUID id,String sku,int total) {
        jdbc.update("INSERT INTO product(id,sku,name,unit_price) VALUES(?,?,?,100)",Uuid7.toBytes(id),sku,"product-"+sku);
        jdbc.update("INSERT INTO stock(product_id,qty,reserved_qty) VALUES(?,?,0)",Uuid7.toBytes(id),total);
    }
    UUID place(int qty) {
        UUID id=UUID.randomUUID();
        service.place(id,"SO-"+id.toString().substring(0,20),customerId,productId,qty,UUID.randomUUID());return id;
    }
    int stock(UUID id,String column) {return jdbc.queryForObject("SELECT "+column+" FROM stock WHERE product_id=?",Integer.class,Uuid7.toBytes(id));}
    long count(String table) {return jdbc.queryForObject("SELECT COUNT(*) FROM "+table,Long.class);}
    String status(UUID id){return jdbc.queryForObject("SELECT status FROM orders WHERE id=?",String.class,Uuid7.toBytes(id));}
    BigDecimal total(UUID id){return jdbc.queryForObject("SELECT total_amount FROM orders WHERE id=?",BigDecimal.class,Uuid7.toBytes(id));}
    UUID firstItem(UUID id){return jdbc.queryForObject("SELECT id FROM order_item WHERE order_id=? LIMIT 1",(rs,n)->Uuid7.fromBytes(rs.getBytes(1)),Uuid7.toBytes(id));}
}
