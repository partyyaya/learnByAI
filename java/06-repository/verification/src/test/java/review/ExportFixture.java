package review;
import org.springframework.stereotype.Service;import org.springframework.transaction.annotation.*;
import java.util.*;import java.io.*;
public class ExportFixture {
 public record OrderExportRow(String orderId){public String toCsv(){return orderId+"\n";}}
 public interface OrderExportPort {List<OrderExportRow> nextChunk(String after,int size);}
 public interface Progress {void save(String id);}
 // COURSE_READER
 public static class Exporter {
 final OrderExportReader chunkReader;final Progress progress;
 Exporter(OrderExportReader reader,Progress progress){this.chunkReader=reader;this.progress=progress;}
 // COURSE_EXPORT
 }
}
