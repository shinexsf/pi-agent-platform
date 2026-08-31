/*
 * pi-agent-idea: IntelliJ 插件（Kotlin + Gradle）。
 * 独立技术栈项目，跟 platform/ Node.js monorepo 不在同一个构建系统。
 *
 * ⚠️ 不要执行 `./gradlew runIde`（会卡住等待手动关闭），由用户手动验证。
 *
 * local IDEA 路径按本机安装调整：
 *   - Windows 默认: C:/Program Files/JetBrains/IntelliJ IDEA 2026.1
 *   - macOS 默认: /Applications/IntelliJ IDEA.app
 */

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.0"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "com.piagent"
version = "0.1.0"

repositories {
    maven { url = uri("https://maven.aliyun.com/repository/public") }
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        intellijDependencies()
    }
}

dependencies {
    intellijPlatform {
        // 本地 IDE 路径 —— 开发者按本机安装调整
        // 注意：production 部署前应改成 intellijPlatform { intellijDependencies() } 自动获取
        local("C:/Program Files/JetBrains/IntelliJ IDEA 2026.1")
        // JCEF 已合并到 platform 模块（2026.1+），不需要单独的 bundledPlugin
    }
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.0")  // Bridge 响应 JSON 序列化
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.18.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks {
    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    test {
        useJUnitPlatform()
    }
    // runIde 会卡住等待手动关闭 —— 不要自动执行
    runIde {
        // 显式不通过 task 依赖触发，留给用户手动验证
    }
}