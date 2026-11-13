package review;
import com.example.lab.guard.SafePages;
import com.example.lab.ch07.*;
import com.github.pagehelper.PageHelper;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import java.math.BigDecimal;
import java.util.stream.IntStream;
import static org.assertj.core.api.Assertions.*;
class PageCleanupTest extends DatabaseFixture {
    @Autowired KeyBatchService writer;
    @Autowired review.mapper.SequenceReader reader;
    @AfterEach void ensureNoThreadLocal(){assertThat(PageHelper.getLocalPage()).isNull();}
    @Test void beforeQueryExceptionAlwaysClearsTheLocalPage(){
        assertThatThrownBy(()->SafePages.select(1,2,()->{throw new IllegalStateException("before query");})).isInstanceOf(IllegalStateException.class);
        assertThat(PageHelper.getLocalPage()).isNull();
        assertThat(reader.all()).isEmpty();
    }
    @Test void normalPageIsLimitedAndFollowingQueryIsUnpaged(){
        writer.insertRows(IntStream.range(0,5).mapToObj(i->new SeqRow("p"+i,BigDecimal.ONE)).toList(),2);
        var page=SafePages.<SeqRow>select(1,2,()->reader.all());
        assertThat(page.getList()).hasSize(2);assertThat(page.getTotal()).isEqualTo(5);
        assertThat(PageHelper.getLocalPage()).isNull();assertThat(reader.all()).hasSize(5);
    }
    @Test void actualQueryFailureAlsoClearsTheLocalPage(){
        assertThatThrownBy(()->SafePages.select(1,2,()->reader.broken())).isInstanceOf(RuntimeException.class);
        assertThat(PageHelper.getLocalPage()).isNull();assertThat(reader.all()).isEmpty();
    }
}
