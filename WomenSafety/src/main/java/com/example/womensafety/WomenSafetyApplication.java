package com.example.womensafety;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class WomenSafetyApplication {

    public static void main(String[] args) {
        SpringApplication.run(WomenSafetyApplication.class, args);
    }

}
