package com.example.toolbox;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import java.nio.file.*;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assertions.*;

class ExampleSmokeTest {
    static Stream<String> examples() throws Exception {
        return Files.readAllLines(Path.of("target/classes.txt")).stream();
    }

    @ParameterizedTest(name = "完整課文範例可執行：{0}")
    @MethodSource("examples")
    void eachCompleteExampleRuns(String className) throws Exception {
        // 課文的 main 原樣執行；HTTP 無參數時不連公網，網路行為另由 fixture 測試。
        var main = Class.forName("com.example.toolbox." + className).getMethod("main", String[].class);
        assertDoesNotThrow(() -> main.invoke(null, (Object) new String[0]));
    }
}
