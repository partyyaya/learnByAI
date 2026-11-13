package review.mapper;
import com.example.lab.ch07.SeqRow;
import org.apache.ibatis.annotations.*;
import java.util.List;
@Mapper
public interface SequenceReader {
    @Select("SELECT id,code,amount FROM seq_row ORDER BY id") List<SeqRow> all();
    @Select("SELECT id FROM intentionally_missing_table") List<Long> broken();
}
